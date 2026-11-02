'use strict';

/**
 * Modrinth 只读客户端（搜索 / 版本 / 下载）。
 *
 * 只依赖 Node 内置的 fetch 与 stream：不引入第三方库，也不在渲染进程里发请求，
 * 这样 UA、超时、重定向与目标目录校验都留在主进程。
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const API_ROOT = 'https://api.modrinth.com/v2';
const USER_AGENT = 'mcdl-launcher/0.2.0 (Electron; +https://modrinth.com)';
const REQUEST_TIMEOUT = 20000;

/** 界面上的内容类型 → Modrinth 的 project_type。 */
const PROJECT_TYPES = {
  mods: 'mod',
  resourcepack: 'resourcepack',
  shader: 'shader'
};

function projectTypeOf(kind) {
  const type = PROJECT_TYPES[String(kind || '')];
  if (!type) throw new Error(`不支持的内容类型：${kind}`);
  return type;
}

class ModrinthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ModrinthError';
    this.status = status;
  }
}

function describeHttp(status) {
  if (status === 404) return '找不到该项目或版本';
  if (status === 429) return '请求过于频繁，请稍后再试';
  if (status >= 500) return 'Modrinth 服务暂时不可用';
  return `Modrinth 请求失败（HTTP ${status}）`;
}

async function request(pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : API_ROOT + pathname;
  let response;

  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ModrinthError('Modrinth 请求超时，请检查网络');
    }
    throw new ModrinthError(`无法连接 Modrinth：${error.message}`);
  }

  if (!response.ok) {
    throw new ModrinthError(describeHttp(response.status), response.status);
  }

  try {
    return await response.json();
  } catch {
    throw new ModrinthError('Modrinth 返回了无法解析的数据');
  }
}

/**
 * 搜索项目。
 * @param {{kind:string, query?:string, gameVersion?:string, loader?:string,
 *          sort?:string, limit?:number, offset?:number}} options
 */
async function searchProjects(options = {}) {
  const kind = String(options.kind || 'mods');
  const projectType = projectTypeOf(kind);
  const query = String(options.query || '').trim();
  const gameVersion = String(options.gameVersion || '').trim();
  const loader = String(options.loader || '').trim();
  const sort = ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(options.sort)
    ? options.sort
    : 'relevance';
  const limit = Math.min(40, Math.max(1, Number(options.limit) || 20));
  const offset = Math.max(0, Number(options.offset) || 0);

  const facets = [[`project_type:${projectType}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);

  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    index: sort,
    limit: String(limit),
    offset: String(offset)
  });

  const data = await request(`/search?${params.toString()}`);
  const hits = Array.isArray(data && data.hits) ? data.hits : [];

  return {
    total: Number(data && data.total_hits) || hits.length,
    offset,
    limit,
    items: hits.map((hit) => ({
      id: String(hit.project_id || hit.slug || ''),
      slug: String(hit.slug || ''),
      title: String(hit.title || '未命名'),
      description: String(hit.description || ''),
      author: String(hit.author || ''),
      iconUrl: String(hit.icon_url || ''),
      downloads: Number(hit.downloads) || 0,
      follows: Number(hit.follows) || 0,
      categories: Array.isArray(hit.categories) ? hit.categories.slice(0, 6) : [],
      projectType: String(hit.project_type || projectType),
      latestVersion: String(hit.latest_version || ''),
      dateModified: String(hit.date_modified || '')
    }))
  };
}

function trimVersion(version) {
  const files = Array.isArray(version && version.files) ? version.files : [];
  const primary = files.find((file) => file && file.primary) || files[0] || null;

  return {
    id: String(version.id || ''),
    name: String(version.name || ''),
    versionNumber: String(version.version_number || ''),
    versionType: String(version.version_type || 'release'),
    datePublished: String(version.date_published || ''),
    downloads: Number(version.downloads) || 0,
    gameVersions: Array.isArray(version.game_versions) ? version.game_versions : [],
    loaders: Array.isArray(version.loaders) ? version.loaders : [],
    dependencies: (Array.isArray(version.dependencies) ? version.dependencies : []).map((dep) => ({
      versionId: dep && dep.version_id ? String(dep.version_id) : '',
      projectId: dep && dep.project_id ? String(dep.project_id) : '',
      type: String((dep && dep.dependency_type) || '')
    })),
    file: primary
      ? {
        url: String(primary.url || ''),
        filename: String(primary.filename || ''),
        size: Number(primary.size) || 0,
        hashes: primary.hashes && typeof primary.hashes === 'object' ? primary.hashes : {}
      }
      : null
  };
}

/**
 * 项目的版本列表，按 Minecraft 版本 / 加载器过滤（Modrinth 侧过滤）。
 */
async function listVersions(options = {}) {
  const projectId = String(options.projectId || '').trim();
  if (!projectId) throw new Error('缺少项目 id');

  const params = new URLSearchParams();
  if (options.gameVersion) params.set('game_versions', JSON.stringify([String(options.gameVersion)]));
  if (options.loader) params.set('loaders', JSON.stringify([String(options.loader)]));

  const query = params.toString();
  const data = await request(`/project/${encodeURIComponent(projectId)}/version${query ? '?' + query : ''}`);
  if (!Array.isArray(data)) throw new ModrinthError('Modrinth 返回的版本列表格式不对');

  return data.map(trimVersion).filter((version) => version.file);
}

async function getVersion(versionId) {
  const id = String(versionId || '').trim();
  if (!id) throw new Error('缺少版本 id');
  return trimVersion(await request(`/version/${encodeURIComponent(id)}`));
}

/**
 * 递归收集必需前置（只处理 dependency_type=required，深度 3、最多 8 个）。
 */
async function collectRequiredDependencies(version, options = {}) {
  const gameVersion = String(options.gameVersion || '').trim();
  const loader = String(options.loader || '').trim();
  const seen = options.seen instanceof Set ? options.seen : new Set();
  const depth = Number(options.depth) || 0;
  const results = [];

  for (const dep of version.dependencies || []) {
    if (dep.type !== 'required') continue;
    if (results.length >= 8) break;
    if (dep.projectId && seen.has(dep.projectId)) continue;
    if (dep.projectId) seen.add(dep.projectId);

    let resolved = null;
    if (dep.versionId) {
      resolved = await getVersion(dep.versionId).catch(() => null);
    }
    if (!resolved && dep.projectId) {
      resolved = (await listVersions({ projectId: dep.projectId, gameVersion, loader }).catch(() => []))[0] || null;
    }
    if (!resolved || !resolved.file) continue;

    results.push(resolved);
    if (depth < 2) {
      const nested = await collectRequiredDependencies(resolved, { gameVersion, loader, seen, depth: depth + 1 });
      for (const item of nested) {
        if (results.length >= 8) break;
        results.push(item);
      }
    }
  }

  return results;
}

function hashOf(algorithm, buffer) {
  return crypto.createHash(algorithm).update(buffer).digest('hex');
}

async function downloadFile(url, target, expectedHashes) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(120000)
  }).catch((error) => {
    throw new ModrinthError(`下载失败：${error.message}`);
  });

  if (!response.ok || !response.body) {
    throw new ModrinthError(`下载失败（HTTP ${response.status}）`, response.status);
  }

  await fs.mkdir(path.dirname(target), { recursive: true });

  const temp = target + '.part';
  await pipeline(Readable.fromWeb(response.body), fsSync.createWriteStream(temp));

  const buffer = await fs.readFile(temp);
  const expected = expectedHashes && expectedHashes.sha1 ? String(expectedHashes.sha1) : '';
  if (expected && hashOf('sha1', buffer) !== expected) {
    await fs.rm(temp, { force: true });
    throw new ModrinthError('下载文件的 SHA1 校验失败');
  }

  await fs.rename(temp, target);
  return { path: target, size: buffer.length };
}

/** 重名时加 (2) / (3)，最多试 100 次。 */
async function uniqueTarget(dir, filename) {
  const base = String(filename || 'download.bin').replace(/[\\/:*?"<>|]/g, '_');
  const ext = path.extname(base);
  let target = path.join(dir, base);

  for (let index = 1; index < 100; index += 1) {
    try {
      await fs.access(target);
      target = path.join(dir, `${path.basename(base, ext)} (${index})${ext}`);
    } catch {
      break;
    }
  }

  return target;
}

/**
 * 把一个版本（含可选前置）下载到目标目录。
 * @returns {Promise<{installed:Array, failed:Array}>}
 */
async function downloadVersion({ version, targetDir, installDependencies = false,
  gameVersion = '', loader = '', onProgress }) {
  if (!version || !version.file || !version.file.url) {
    throw new ModrinthError('该版本没有可下载的文件');
  }

  const notify = (message, done, total) => {
    if (typeof onProgress === 'function') onProgress({ message, done, total });
  };

  const installed = [];
  const failed = [];

  const target = await uniqueTarget(targetDir, version.file.filename);
  notify(`正在下载 ${version.file.filename} …`, 0, 1);
  const saved = await downloadFile(version.file.url, target, version.file.hashes);
  installed.push({ filename: path.basename(target), path: saved.path, size: saved.size });

  if (!installDependencies) return { installed, failed };

  const deps = await collectRequiredDependencies(version, { gameVersion, loader });
  let index = 0;

  for (const dep of deps) {
    index += 1;
    notify(`正在下载前置 ${index}/${deps.length}：${dep.file.filename} …`, index, deps.length + 1);
    try {
      const depTarget = await uniqueTarget(targetDir, dep.file.filename);
      const depSaved = await downloadFile(dep.file.url, depTarget, dep.file.hashes);
      installed.push({ filename: path.basename(depTarget), path: depSaved.path, size: depSaved.size });
    } catch (error) {
      failed.push({ filename: dep.file.filename, error: error.message });
    }
  }

  notify('下载完成', deps.length + 1, deps.length + 1);
  return { installed, failed };
}

module.exports = {
  PROJECT_TYPES,
  ModrinthError,
  searchProjects,
  listVersions,
  getVersion,
  collectRequiredDependencies,
  downloadVersion,
  projectTypeOf
};
