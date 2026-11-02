'use strict';

/**
 * 导出整合包（实例详情 / 实例菜单的「导出整合包」）。
 *
 * HMCL 的导出向导会区分 CurseForge / Modrinth 两种格式，并在第三步让你挑「包含哪些文件夹」。
 * 这里同样做三页：类型 → 文件 → 信息，但导出本身用「本地文件全部放进 overrides/」的最简形态：
 *
 *   manifest.json            CurseForge 格式（minecraft.version + modLoaders）
 *   modrinth.index.json      Modrinth 格式（dependencies + overrides）
 *   overrides/<原目录结构>    选中的 mods / config / 存档…
 *
 * 为什么不生成远程 `files` 列表：本地文件没有 CurseForge project/file id，Modrinth 也需要
 * 先查到对应版本，否则做出来的包在别的启动器里会因为「找不到文件」而装不上。
 * 把文件放 overrides 是两种格式都合法、也一定能装上的做法。
 *
 * 打包用系统自带 tar.exe（bsdtar），不引入 zip 依赖；先写到临时目录再整体压缩，
 * 因此压缩包里不会出现「manifest 还没写完就被读」的中间态。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { writeFileAtomic } = require('./atomic-write');

const MAX_FILES = 20000;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;   // 8 GB 上限，防止把整个磁盘塞进 zip
const HASH_LIMIT_BYTES = 256 * 1024 * 1024;       // 超过这个大小就不算 sha1（"不匹配远程文件"）

const CATEGORY_DEFS = [
  { key: 'mods', label: '模组', dirs: ['mods'], defaultOn: true },
  { key: 'config', label: '配置', dirs: ['config', 'defaultconfigs'], defaultOn: true },
  { key: 'resourcepacks', label: '资源包', dirs: ['resourcepacks'], defaultOn: true },
  { key: 'shaderpacks', label: '光影包', dirs: ['shaderpacks'], defaultOn: true },
  { key: 'saves', label: '存档', dirs: ['saves'], defaultOn: false },
  { key: 'schematics', label: '投影', dirs: ['schematics'], defaultOn: false },
  {
    key: 'options',
    label: '游戏选项',
    dirs: [],
    files: ['options.txt', 'optionsof.txt', 'iris.properties', 'servers.dat'],
    defaultOn: true
  }
];

const LOADER_KEYS = {
  Forge: 'forge',
  NeoForge: 'neoforge',
  Fabric: 'fabric-loader',
  Quilt: 'quilt-loader'
};

const MC_VERSION_RE = /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/;

/**
 * 实例的 Minecraft 版本。
 *
 * 外部实例的显示名常常是整合包名字（中文），`versionName` 在这种情况下会退化成
 * 文件夹名，直接写进清单会让别的启动器装错版本。这里先读版本 JSON，用
 * inheritsFrom / id 里能对上的版本号，实在没有才用 versionName。
 */
async function resolveMinecraftVersion(instance, versionDir) {
  const direct = String(instance.versionName || '').trim();
  if (MC_VERSION_RE.test(direct)) return direct;

  let entries = [];
  try {
    entries = await fs.readdir(versionDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(versionDir, entry.name), 'utf8'));
    } catch {
      continue;
    }
    for (const candidate of [parsed.inheritsFrom, parsed.id, entry.name.replace(/\.json$/i, '')]) {
      const value = String(candidate || '').trim();
      const match = value.match(/(?:^|[^\d])(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)(?:[^\d]|$)/);
      if (match && MC_VERSION_RE.test(match[1])) return match[1];
    }
  }

  return direct;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

function safeSegment(name) {
  const value = String(name || '').trim();
  if (!value || value === '.' || value === '..') return '';
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(value)) return '';
  return value;
}

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

/** 递归收集一个目录下的文件（相对 root 的路径）。 */
async function walkFiles(root, dir, out, state) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (state.count >= MAX_FILES) return;
    if (entry.name.startsWith('.')) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, full, out, state);
      continue;
    }
    if (!entry.isFile()) continue;

    const stat = await statOrNull(full);
    if (!stat) continue;
    state.bytes += stat.size;
    state.count += 1;
    if (state.bytes > MAX_TOTAL_BYTES) {
      throw new Error(`选中的文件超过 ${formatBytes(MAX_TOTAL_BYTES)}，请减少勾选的文件夹`);
    }

    out.push({
      rel: path.relative(root, full).split(path.sep).join('/'),
      size: stat.size,
      source: full
    });
  }
}

/**
 * 扫描实例里可以导出的内容。
 * 版本隔离实例的文件在 versions/<id>/ 下，非隔离实例在游戏目录下；两边都扫，
 * 同一条相对路径以实例目录里的那份为准。
 */
async function scanInstance(instance) {
  const versionDir = path.resolve(instance.path || '');
  const gameDir = path.resolve(instance.gameDir || '');
  const roots = [versionDir, gameDir].filter(Boolean);

  const categories = [];

  for (const def of CATEGORY_DEFS) {
    const seen = new Map();

    for (const root of roots) {
      for (const dir of def.dirs || []) {
        const full = path.join(root, dir);
        const stat = await statOrNull(full);
        if (!stat || !stat.isDirectory()) continue;
        const files = [];
        const local = { count: 0, bytes: 0 };
        await walkFiles(root, full, files, local);
        for (const file of files) {
          if (!seen.has(file.rel)) seen.set(file.rel, { ...file, category: def.key });
        }
      }

      for (const file of def.files || []) {
        const full = path.join(root, file);
        const stat = await statOrNull(full);
        if (!stat || !stat.isFile()) continue;
        if (!seen.has(file)) seen.set(file, { rel: file, size: stat.size, source: full, category: def.key });
      }
    }

    const files = Array.from(seen.values()).sort((a, b) => a.rel.localeCompare(b.rel, 'en'));
    const total = files.reduce((sum, file) => sum + file.size, 0);
    categories.push({
      key: def.key,
      label: def.label,
      defaultOn: Boolean(def.defaultOn),
      files,
      total,
      totalLabel: total ? formatBytes(total) : '—'
    });
  }

  const loaderKey = LOADER_KEYS[String(instance.modLoader || instance.loaderLabel || '')] ||
    LOADER_KEYS[String(instance.loaderLabel || '')] || '';
  const mcVersion = await resolveMinecraftVersion(instance, versionDir);

  return {
    instanceId: instance.id,
    name: instance.displayName || instance.versionName || instance.id,
    versionName: mcVersion,
    loader: loaderKey,
    loaderLabel: instance.modLoader || instance.loaderLabel || 'Vanilla',
    loaderVersion: instance.modLoaderVersion || '',
    gameDir,
    versionDir,
    categories: categories,
    totalFiles: categories.reduce((sum, category) => sum + category.files.length, 0),
    totalBytes: categories.reduce((sum, category) => sum + category.total, 0),
    suggestedVersion: '1.0.0'
  };
}

function sanitizeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 80) || 'modpack';
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const child = spawn(tar, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => reject(new Error(`tar 启动失败：${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`打包失败（tar 退出码 ${code}）${stderr ? '：' + stderr.trim().split(/\r?\n/).slice(-2).join(' ') : ''}`));
    });
  });
}

async function hashFile(file) {
  const stat = await statOrNull(file);
  if (!stat || stat.size > HASH_LIMIT_BYTES) return { sha1: '', sha512: '' };

  // 流式读取：几百 MB 的整合包内容不应该整份读进内存。
  return new Promise((resolve, reject) => {
    const sha1 = crypto.createHash('sha1');
    const sha512 = crypto.createHash('sha512');
    const stream = require('node:fs').createReadStream(file);
    stream.on('data', (chunk) => {
      sha1.update(chunk);
      sha512.update(chunk);
    });
    stream.on('end', () => resolve({
      sha1: sha1.digest('hex'),
      sha512: sha512.digest('hex')
    }));
    stream.on('error', reject);
  });
}

async function writeJson(file, data) {
  // 原子写：导出清单是最终产物，半截 JSON 会让别的启动器判定整包无效。
  await writeFileAtomic(file, JSON.stringify(data, null, 2), { encoding: 'utf8' });
}

/**
 * 真正的导出。
 *
 * @param {object} options
 * @param {object} options.instance      实例快照（含 path / gameDir / modLoader…）
 * @param {object} options.scan          scanInstance() 的结果（避免重复扫盘）
 * @param {string} options.format        'curseforge' | 'modrinth'
 * @param {string[]} options.selection   选中的 category key
 * @param {{name:string,version:string,author:string,summary:string}} options.meta
 * @param {{server:string,forceUpdate:boolean,includeLauncher:boolean,
 *          noRemoteMatch:boolean,skipCurseforge:boolean}} options.options
 * @param {string} options.targetFile    目标 .zip
 * @param {Function} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 */
async function exportPack(options = {}) {
  const scan = options.scan && Array.isArray(options.scan.categories) ? options.scan : null;
  if (!scan) throw new Error('缺少实例扫描结果');

  const format = options.format === 'modrinth' ? 'modrinth' : 'curseforge';
  const selection = new Set(Array.isArray(options.selection) ? options.selection : []);
  const meta = options.meta || {};
  const flags = options.options || {};
  const target = path.resolve(String(options.targetFile || ''));
  if (!target.toLowerCase().endsWith('.zip')) throw new Error('导出文件必须是 .zip');

  const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const signal = options.signal || null;

  const chosen = scan.categories.filter((category) => selection.has(category.key) && category.files.length > 0);
  if (chosen.length === 0) throw new Error('至少勾选一个包含文件的文件夹');

  const workRoot = path.join(path.dirname(target), `.mcdl-export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const staging = path.join(workRoot, 'staging');
  const overrides = path.join(staging, 'overrides');
  await fs.mkdir(overrides, { recursive: true });

  try {
    const fileEntries = [];
    let copied = 0;
    let totalBytes = 0;

    for (const category of chosen) {
      for (const file of category.files) {
        if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { cancelled: true, code: 'TASK_CANCELLED' });
        const rel = file.rel.split('/').map(safeSegment);
        if (rel.some((segment) => !segment)) {
          report(`跳过非法路径：${file.rel}`);
          continue;
        }

        const destRel = path.join(...rel);
        const dest = path.join(overrides, destRel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(file.source, dest);

        copied += 1;
        totalBytes += file.size;
        if (copied % 25 === 0 || copied === 1) {
          report(`正在收集文件 ${copied}（${formatBytes(totalBytes)}）`, Math.min(45, Math.round((copied / Math.max(1, scan.totalFiles)) * 45)));
        }

        fileEntries.push({
          path: rel.join('/'),
          size: file.size,
          category: category.key
        });
      }
    }

    if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { cancelled: true, code: 'TASK_CANCELLED' });

    report('正在写入整合包清单…', 55);

    // 「不匹配远程文件」关掉时才对文件做哈希；打开时只记录路径与大小（更快）。
    const hashList = [];
    if (!flags.noRemoteMatch) {
      let hashed = 0;
      for (const entry of fileEntries) {
        if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { cancelled: true, code: 'TASK_CANCELLED' });
        hashed += 1;
        if (hashed % 100 === 0 || hashed === fileEntries.length) {
          report(`正在计算文件校验（${hashed}/${fileEntries.length}）`, 55 + Math.round((hashed / Math.max(1, fileEntries.length)) * 12));
        }
        if (entry.size > HASH_LIMIT_BYTES) {
          hashList.push({ path: entry.path, size: entry.size, sha1: '', skipped: '文件过大，未计算哈希' });
          continue;
        }
        const full = path.join(overrides, ...entry.path.split('/'));
        const hashes = await hashFile(full);
        hashList.push({ path: entry.path, size: entry.size, sha1: hashes.sha1, sha512: hashes.sha512 });
      }
    }

    const packName = String(meta.name || scan.name || '整合包').slice(0, 80);
    const packVersion = String(meta.version || scan.suggestedVersion || '1.0.0').slice(0, 40);
    const author = String(meta.author || '').slice(0, 80);
    const summary = String(meta.summary || '').slice(0, 400);
    const mcVersion = scan.versionName || '';
    const loader = scan.loader || '';
    const loaderVersion = scan.loaderVersion || '';

    const mcdlMeta = {
      exportedAt: new Date().toISOString(),
      exportedBy: 'MCDL Launcher',
      format,
      instance: scan.name,
      minecraft: mcVersion,
      loaderLabel: scan.loaderLabel || 'Vanilla',
      loader,
      loaderVersion,
      fileCount: fileEntries.length,
      server: String(flags.server || ''),
      forceUpdate: Boolean(flags.forceUpdate),
      includeLauncher: Boolean(flags.includeLauncher),
      noRemoteMatch: Boolean(flags.noRemoteMatch),
      skipCurseforge: Boolean(flags.skipCurseforge),
      files: flags.noRemoteMatch ? [] : hashList
    };

    if (format === 'modrinth') {
      const dependencies = {};
      if (mcVersion) dependencies.minecraft = mcVersion;
      if (loader && loaderVersion) dependencies[loader] = loaderVersion;

      await writeJson(path.join(staging, 'modrinth.index.json'), {
        formatVersion: 1,
        game: 'minecraft',
        versionId: packVersion,
        name: packName,
        summary: summary || `${packName} · 由 MCDL Launcher 导出`,
        files: [],
        dependencies,
        mcdl: mcdlMeta
      });
    } else {
      const modLoaders = loader
        ? [{ id: loaderVersion ? `${loader}-${loaderVersion}` : loader, primary: true }]
        : [];

      await writeJson(path.join(staging, 'manifest.json'), {
        minecraft: {
          version: mcVersion,
          modLoaders
        },
        manifestType: 'minecraftModpack',
        manifestVersion: 1,
        name: packName,
        version: packVersion,
        author,
        description: summary,
        files: [],
        overrides: 'overrides',
        mcdl: mcdlMeta
      });
    }

    // HMCL 家族习惯在包根放一份说明：别的启动器不认 manifest 时也能看懂。
    await writeFileAtomic(
      path.join(staging, 'README-整合包.txt'),
      [
        `整合包：${packName}  ${packVersion}`,
        author ? `作者：${author}` : '',
        summary ? `说明：${summary}` : '',
        '',
        `Minecraft：${mcVersion || '未记录'}`,
        `加载器：${scan.loaderLabel || 'Vanilla'}${loaderVersion ? ' ' + loaderVersion : ''}`,
        `导出方式：MCDL Launcher（${format === 'modrinth' ? 'Modrinth' : 'CurseForge'} 格式）`,
        '',
        '所有内容文件都在 overrides/ 下，按原目录结构覆盖到实例即可。',
        flags.forceUpdate ? '本包标记为「强制升级整合包至最新版本」。' : '',
        flags.includeLauncher ? '本包包含启动器说明（launcher/）。' : '',
        ''
      ].filter((line) => line !== '').join('\n') + '\n',
      { encoding: 'utf8' }
    );

    if (flags.includeLauncher) {
      const launcherDir = path.join(staging, 'launcher');
      await writeFileAtomic(
        path.join(launcherDir, 'README.txt'),
        [
          'MCDL Launcher',
          '=============',
          '',
          '这个整合包是 MCDL Launcher 导出的。启动器本体不在压缩包里（Electron 应用体积太大，',
          '也不适合随整合包分发），请到项目主页获取：',
          '',
          'https://github.com/jkoyli/mcdl-launcher',
          '',
          '装上启动器后，把本整合包拖进「下载 → 整合包」即可安装。',
          ''
        ].join('\n'),
        { encoding: 'utf8' }
      );
    }

    if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { cancelled: true, code: 'TASK_CANCELLED' });

    report('正在压缩整合包…', 70);

    const entries = (await fs.readdir(staging, { withFileTypes: true })).map((entry) => entry.name);
    if (entries.length === 0) throw new Error('没有可打包的内容');
    await runTar(['-a', '-c', '-f', target, '-C', staging, ...entries]);

    const stat = await fs.stat(target);
    report(`已导出 ${path.basename(target)}（${formatBytes(stat.size)}）`, 100);

    return {
      file: target,
      size: stat.size,
      fileCount: fileEntries.length,
      format,
      packName,
      packVersion
    };
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  CATEGORY_DEFS,
  scanInstance,
  exportPack,
  sanitizeFileName,
  formatBytes
};
