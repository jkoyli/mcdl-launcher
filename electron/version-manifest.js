'use strict';

/**
 * 版本 JSON 解析：处理 libraries / rules / arguments / natives。
 *
 * 覆盖两类情况：
 *   - 原版 json：带 arguments（1.13+）或 minecraftArguments（1.12-）
 *   - 加载器 json：带 inheritsFrom，需要和父版本合并后再构造命令
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const OS_NAME = process.platform === 'win32'
  ? 'windows'
  : process.platform === 'darwin'
    ? 'osx'
    : 'linux';

const OS_ARCH = process.arch === 'ia32'
  ? 'x86'
  : process.arch === 'arm64'
    ? 'arm64'
    : 'x86_64';

// 32 位 Windows 上 ${arch} 是 32，其余是 64。旧版 natives 字段使用这个占位符。
const ARCH_BITS = process.arch === 'ia32' ? '32' : '64';

async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * rules 求值。与官方启动器一致：
 *   - 没有 rules → 允许
 *   - 否则按顺序应用，最后一条匹配的规则决定结果
 *   - 没有任何规则匹配 → 拒绝
 */
function rulesAllow(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;

  let allowed = false;

  for (const rule of rules) {
    if (!rule || typeof rule.action !== 'string') continue;

    let matches = true;

    if (rule.os) {
      if (rule.os.name && rule.os.name !== OS_NAME) matches = false;
      if (matches && rule.os.arch && rule.os.arch !== OS_ARCH && rule.os.arch !== process.arch) {
        matches = false;
      }
      if (matches && rule.os.version && !new RegExp(rule.os.version).test(process.getSystemVersion ? process.getSystemVersion() : '')) {
        // 系统版本匹配在 Windows 10/11 上意义有限，匹配不到就当作不匹配。
        matches = false;
      }
    }

    if (matches && rule.features) {
      for (const [key, expected] of Object.entries(rule.features)) {
        if (Boolean(features[key]) !== Boolean(expected)) {
          matches = false;
          break;
        }
      }
    }

    if (matches) allowed = rule.action === 'allow';
  }

  return allowed;
}

/** maven 坐标 → libraries 下的相对路径。 */
function mavenToPath(coordinate) {
  const [withoutExt, ext] = String(coordinate).split('@');
  const parts = withoutExt.split(':');
  const [group, artifact, version, classifier] = parts;
  if (!group || !artifact || !version) return null;

  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.${ext || 'jar'}`
    : `${artifact}-${version}.${ext || 'jar'}`;

  return [
    group.replace(/\./g, '/'),
    artifact,
    version,
    fileName
  ].join('/');
}

function libraryArtifactPath(library) {
  const downloads = library && library.downloads;
  if (downloads && downloads.artifact && downloads.artifact.path) {
    return downloads.artifact.path;
  }
  return mavenToPath(library && library.name);
}

/** 旧版 natives 字段里当前平台对应的 classifier 名。 */
function nativeClassifier(library) {
  if (!library || !library.natives) return null;
  const raw = library.natives[OS_NAME];
  if (!raw) return null;
  return String(raw).replace(/\$\{arch\}/g, ARCH_BITS);
}

/**
 * 新版本（1.19+）把 natives 作为独立 library 出现，
 * 名字形如 org.lwjgl:lwjgl:3.3.1:natives-windows。
 */
function isModernNativeLibrary(library) {
  const name = String((library && library.name) || '');
  if (!name) return false;
  const parts = name.split(':');
  if (parts.length < 4) return false;
  const classifier = parts[3].split('@')[0];
  if (!classifier) return false;

  const platformToken = OS_NAME === 'osx' ? 'macos' : OS_NAME;
  if (!classifier.startsWith(`natives-${platformToken}`)) return false;

  // 区分 x86_64 / arm64 / x86
  if (OS_ARCH === 'arm64') return !classifier.includes('x86');
  if (OS_ARCH === 'x86') return classifier.includes('x86') && !classifier.includes('x86_64');
  return !classifier.includes('arm64');
}

function nativeArtifactPath(library) {
  if (!library) return null;

  const downloads = library.downloads;
  const classifier = nativeClassifier(library);
  if (classifier && downloads && downloads.classifiers && downloads.classifiers[classifier]) {
    const entry = downloads.classifiers[classifier];
    if (entry && entry.path) return entry.path;
  }
  if (classifier) {
    return mavenToPath(`${library.name}:${classifier}`);
  }
  if (isModernNativeLibrary(library)) {
    return libraryArtifactPath(library);
  }
  return null;
}

/** 读取沿 inheritsFrom 链的所有 json，根在前、子在后。 */
async function loadVersionChain(gameDir, versionId) {
  const chain = [];
  let currentId = versionId;
  const visited = new Set();

  for (let depth = 0; depth < 8; depth += 1) {
    if (!currentId || visited.has(currentId)) break;
    visited.add(currentId);

    const versionDir = path.join(gameDir, 'versions', currentId);
    const jsonFile = path.join(versionDir, `${currentId}.json`);
    if (!(await exists(jsonFile))) break;

    const manifest = await readJson(jsonFile);
    chain.unshift({ id: currentId, dir: versionDir, manifest });
    currentId = manifest && typeof manifest.inheritsFrom === 'string' ? manifest.inheritsFrom : null;
  }

  return chain;
}

function dedupeLibraries(libraries) {
  const byName = new Map();
  for (const library of libraries) {
    if (!library) continue;
    // 用 group:artifact:version[:classifier] 作为 key，后出现的（更具体的子版本）覆盖前面的。
    byName.set(String(library.name || ''), library);
  }
  return Array.from(byName.values());
}

/** 合并 inheritsFrom 链，得到一份可直接构造命令的版本描述。 */
function mergeChain(chain) {
  const merged = {
    id: chain.length > 0 ? chain[chain.length - 1].id : null,
    type: 'release',
    mainClass: '',
    assets: '',
    assetIndex: null,
    javaVersion: null,
    downloads: null,
    logging: null,
    libraries: [],
    arguments: { jvm: [], game: [] },
    minecraftArguments: null,
    jar: null,
    minimumLauncherVersion: 0
  };

  const libraries = [];
  let hasArgumentsObject = false;

  for (const { id, manifest } of chain) {
    if (!manifest) continue;

    if (manifest.type) merged.type = manifest.type;
    if (manifest.mainClass) merged.mainClass = manifest.mainClass;
    if (manifest.assets) merged.assets = manifest.assets;
    if (manifest.assetIndex) merged.assetIndex = manifest.assetIndex;
    if (manifest.javaVersion) merged.javaVersion = manifest.javaVersion;
    if (manifest.downloads) merged.downloads = manifest.downloads;
    if (manifest.logging) merged.logging = manifest.logging;
    if (manifest.jar) merged.jar = manifest.jar;
    if (typeof manifest.minimumLauncherVersion === 'number') {
      merged.minimumLauncherVersion = manifest.minimumLauncherVersion;
    }

    if (Array.isArray(manifest.libraries)) libraries.push(...manifest.libraries);

    if (manifest.arguments && typeof manifest.arguments === 'object') {
      hasArgumentsObject = true;
      if (Array.isArray(manifest.arguments.jvm)) merged.arguments.jvm.push(...manifest.arguments.jvm);
      if (Array.isArray(manifest.arguments.game)) merged.arguments.game.push(...manifest.arguments.game);
    }

    if (typeof manifest.minecraftArguments === 'string' && manifest.minecraftArguments.trim()) {
      merged.minecraftArguments = manifest.minecraftArguments;
    }

    merged.id = id;
  }

  merged.libraries = dedupeLibraries(libraries);
  // 1.12 及更早的加载器 json 只有 minecraftArguments，没有 arguments 对象。
  if (hasArgumentsObject) merged.minecraftArguments = null;

  return merged;
}

/** 客户端 jar 所在版本目录：按 jar → 子版本 → 祖先顺序找真正存在的 jar。 */
async function resolveClientJar(gameDir, chain, merged) {
  const candidates = [];
  if (merged.jar) candidates.push(merged.jar);
  for (let i = chain.length - 1; i >= 0; i -= 1) candidates.push(chain[i].id);

  for (const id of candidates) {
    if (!id) continue;
    const jar = path.join(gameDir, 'versions', id, `${id}.jar`);
    if (await exists(jar)) return { id, path: jar };
  }

  // jar 不存在也返回一个约定路径，让启动报错信息更直白。
  const fallback = candidates[candidates.length - 1] || merged.id;
  return {
    id: fallback,
    path: path.join(gameDir, 'versions', fallback, `${fallback}.jar`),
    missing: true
  };
}

/**
 * 计算 classpath 与需要解压的 natives。
 * @returns {{classpath:string[], natives:Array<{path:string,name:string}>, skipped:string[]}}
 */
function collectLibraries(merged, gameDir, features) {
  const librariesDir = path.join(gameDir, 'libraries');
  const classpath = [];
  const natives = [];
  const skipped = [];

  for (const library of merged.libraries) {
    if (!rulesAllow(library.rules, features)) continue;

    // 旧版 natives 是同一个 library 的额外 classifier：主 jar 进 classpath，
    // classifier jar 解压到 natives 目录。现代版本 natives 本身就是 artifact。
    const nativePath = nativeArtifactPath(library);
    if (nativePath) {
      natives.push({ path: path.join(librariesDir, nativePath), name: String(library.name || nativePath) });
    }

    const artifact = libraryArtifactPath(library);
    if (artifact) {
      classpath.push(path.join(librariesDir, artifact));
    } else if (!nativePath) {
      skipped.push(String(library.name || '(unnamed)'));
    }
  }

  return { classpath, natives, skipped };
}

module.exports = {
  OS_NAME,
  OS_ARCH,
  ARCH_BITS,
  readJson,
  exists,
  rulesAllow,
  mavenToPath,
  libraryArtifactPath,
  nativeClassifier,
  nativeArtifactPath,
  isModernNativeLibrary,
  loadVersionChain,
  mergeChain,
  resolveClientJar,
  collectLibraries
};
