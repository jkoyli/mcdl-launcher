'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// mcdl 是 mcdl-launcher 的内置子模块：
//   mcdl-launcher/electron/mcdl-service.js
//   mcdl-launcher/mcdl/mcdl.jar
// 不再引用项目外的 ../mcdl。
const MCDL_JAR = process.env.MCDL_JAR
  ? path.resolve(process.env.MCDL_JAR)
  : path.join(__dirname, '..', 'mcdl', 'mcdl.jar');

const JAVA_BIN = resolveJavaBinary();
const APP_DATA_DIR = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LAUNCHER_HOME = path.join(APP_DATA_DIR, 'MCDL Launcher');
// MCDL Launcher 自己的游戏目录。PCL/HMCL 的自动定位不再作为默认来源。
const DEFAULT_GAME_DIR = process.env.MCDL_GAME_DIR
  ? path.resolve(process.env.MCDL_GAME_DIR)
  : path.join(LAUNCHER_HOME, '.minecraft');

const GAME_SUBDIRS = [
  'versions',
  'libraries',
  'assets',
  path.join('assets', 'indexes'),
  path.join('assets', 'objects'),
  'logs',
  'saves',
  'mods',
  'resourcepacks',
  'shaderpacks'
];

let gameDirCache = null;
let versionCache = null;
let versionCacheAt = 0;

function resolveJavaBinary() {
  const configured = process.env.MCDL_JAVA;
  if (!configured) return 'java';

  const resolved = path.resolve(configured);
  return path.extname(resolved).toLowerCase() === '.exe'
    ? resolved
    : path.join(resolved, 'bin', 'java.exe');
}

function runMcdl(args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let finished = false;

    const env = { ...process.env };
    // Avoid polluted JVM options and the "Picked up ..." stderr noise.
    delete env.JAVA_TOOL_OPTIONS;
    delete env.JDK_JAVA_OPTIONS;
    delete env._JAVA_OPTIONS;
    delete env.JAVA_OPTIONS;

    const child = spawn(JAVA_BIN, ['-Dfile.encoding=UTF-8', '-jar', MCDL_JAR, ...args], {
      cwd: path.dirname(MCDL_JAR),
      windowsHide: true,
      env
    });

    const emit = (chunk, stream) => {
      const text = String(chunk);
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (typeof options.onData === 'function') {
        options.onData(text, stream);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => emit(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => emit(chunk, 'stderr'));

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      reject(new Error(`无法启动 Java/mcdl: ${error.message}`));
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = (stderr || stdout).trim().split(/\r?\n/).slice(-8).join('\n');
        const error = new Error(`mcdl 执行失败（退出码 ${code}）${detail ? `\n${detail}` : ''}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = code;
        reject(error);
      }
    });
  });
}

function parseGameDirs(output) {
  const results = [];
  const seen = new Set();

  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/([A-Za-z]:\\[^\r\n]*?\.minecraft)(?=\s{2,}|$)/);
    if (!match) continue;

    const dir = match[1].trim();
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    results.push(dir);
  }

  return results;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureGameDir(dir = DEFAULT_GAME_DIR) {
  const resolved = path.resolve(dir);
  await fs.mkdir(resolved, { recursive: true });

  for (const subdir of GAME_SUBDIRS) {
    await fs.mkdir(path.join(resolved, subdir), { recursive: true });
  }

  // 和 HMCL/PCL 的目录标记类似：让这个目录明确属于 MCDL Launcher。
  const marker = path.join(resolved, 'mcdl-launcher.json');
  if (!(await exists(marker))) {
    const markerData = {
      launcher: 'MCDL Launcher',
      layout: 'minecraft',
      createdAt: new Date().toISOString()
    };
    await fs.writeFile(marker, JSON.stringify(markerData, null, 2), 'utf8').catch(() => {});
  }

  return resolved;
}

async function detectGameDir() {
  if (gameDirCache) return gameDirCache;

  gameDirCache = await ensureGameDir(DEFAULT_GAME_DIR);
  return gameDirCache;
}

/**
 * 显式扫描 PCL / HMCL 等其他启动器位置。
 * 默认启动流程不会调用这个函数；只有用户点击「扫描实例」才执行。
 */
async function findOtherGameDirs() {
  const ownDir = await detectGameDir();
  const result = await runMcdl(['--list-dirs']);
  const dirs = parseGameDirs(result.stdout);
  const ownKey = path.resolve(ownDir).toLowerCase();
  const seen = new Set();
  const others = [];

  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    const key = resolved.toLowerCase();
    if (key === ownKey || seen.has(key)) continue;
    seen.add(key);
    others.push(resolved);
  }

  return others;
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 8);
}

function detectLoader(meta) {
  const libraries = Array.isArray(meta.libraries)
    ? meta.libraries.map((entry) => String(entry && entry.name || '')).join(' ').toLowerCase()
    : '';
  const mainClass = String(meta.mainClass || '').toLowerCase();

  if (/net\.quiltmc|quilt-loader/.test(libraries)) return 'Quilt';
  if (/net\.fabricmc|fabric-loader/.test(libraries)) return 'Fabric';
  if (/net\.neoforged|neoforge/.test(libraries)) return 'NeoForge';
  if (/net\.minecraftforge|minecraftforge/.test(libraries) || /bootstraplauncher/.test(mainClass)) {
    return 'Forge';
  }

  return 'Vanilla';
}

function detectGameVersion(meta, folderName) {
  if (meta.inheritsFrom) return String(meta.inheritsFrom);

  const candidates = [meta.id, folderName];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const match = value.match(/(?:^|[^\d])(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)(?:[^\d]|$)/);
    if (match) return match[1];
  }

  return typeof meta.id === 'string' ? meta.id : folderName;
}

async function findVersionJson(versionDir, folderName) {
  const preferred = path.join(versionDir, `${folderName}.json`);
  if (await exists(preferred)) {
    return { file: preferred, manifest: await readJson(preferred) };
  }

  let entries;
  try {
    entries = await fs.readdir(versionDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const file = path.join(versionDir, entry.name);
    let manifest;
    try {
      manifest = await readJson(file);
    } catch {
      continue;
    }

    if (manifest && typeof manifest.id === 'string' &&
        (typeof manifest.mainClass === 'string' || manifest.arguments || manifest.minecraftArguments)) {
      return { file, manifest };
    }
  }

  return null;
}

async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function readHmclSettings(versionDir) {
  const file = path.join(versionDir, '.hmcl', 'config', 'instance-game-settings.json');
  if (!(await exists(file))) return null;

  try {
    return await readJson(file);
  } catch {
    return null;
  }
}

async function scanInstances(gameDir, aliases = {}, options = {}) {
  const dir = path.resolve(gameDir || await detectGameDir());
  const primary = options.primary !== false;
  const idSuffix = primary ? '' : '@' + shortHash(dir);
  const versionsDir = path.join(dir, 'versions');
  let entries;

  try {
    entries = await fs.readdir(versionsDir, { withFileTypes: true });
  } catch {
    return { gameDir: dir, instances: [], selectedId: null };
  }

  const instances = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const versionDir = path.join(versionsDir, entry.name);
    let found;
    try {
      found = await findVersionJson(versionDir, entry.name);
    } catch {
      continue;
    }
    if (!found) continue;

    const { manifest, file } = found;
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }

    const settings = await readHmclSettings(versionDir);
    const loader = detectLoader(manifest);
    const gameVersion = detectGameVersion(manifest, entry.name);
    const javaRequirement = manifest.javaVersion && manifest.javaVersion.majorVersion
      ? String(manifest.javaVersion.majorVersion)
      : '';
    const detectedJava = settings && settings.detectedJava && settings.detectedJava.version
      ? String(settings.detectedJava.version)
      : '';

    instances.push({
      id: primary ? entry.name : entry.name + idSuffix,
      displayName: aliases[versionDir] || entry.name,
      origin: primary ? 'own' : 'external',
      sourceLabel: primary ? '' : '外部',
      versionName: gameVersion,
      modLoader: loader === 'Vanilla' ? '' : loader,
      modLoaderVersion: '',
      javaVersion: detectedJava || javaRequirement,
      javaRequirement,
      installedVersions: 1,
      lastPlayed: stat.mtime.toISOString(),
      memoryMb: null,
      jvmArgs: settings && settings.jvmOptions ? settings.jvmOptions : '',
      windowWidth: null,
      windowHeight: null,
      fullscreen: null,
      profileName: entry.name,
      status: 'Ready',
      launchStatus: 'Installed',
      path: versionDir,
      gameDir: dir,
      loaderLabel: loader
    });
  }

  instances.sort((a, b) => String(b.lastPlayed).localeCompare(String(a.lastPlayed)));

  return {
    gameDir: dir,
    instances,
    selectedId: instances.length > 0 ? instances[0].id : null
  };
}

/**
 * mcdl 的 `--list-java` 会顺带查注册表，比纯目录扫描多找到一些安装。
 * 这里只提取其中的绝对路径，不解析中文表格里的版本/架构文字。
 */
async function listJavaPaths() {
  const result = await runMcdl(['--list-java']);
  const paths = [];
  const seen = new Set();

  for (const line of String(result.stdout).split(/\r?\n/)) {
    const matches = line.match(/[A-Za-z]:\\[^\r\n]*?java\.exe/gi);
    if (!matches) continue;
    for (const match of matches) {
      const key = match.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(match);
    }
  }

  return paths;
}

function normalizeVersionType(label) {
  if (label === '快照') return 'snapshot';
  if (label === '远古 Alpha' || label === '远古 Beta') return 'old';
  return 'release';
}

async function listVersions() {
  const now = Date.now();
  if (versionCache && now - versionCacheAt < 10 * 60 * 1000) {
    return versionCache;
  }

  const result = await runMcdl(['--list', '--type', 'all']);
  const versions = [];

  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    // 版本 ID 本身可能包含空格（如 1.14.2 Pre-Release 4 / 3D Shareware v1.34），
    // 所以从右侧的已知类型标签和日期反解，而不是按第一个空格切分。
    const match = trimmed.match(/^(.*?)\s+(正式版|快照|远古 Alpha|远古 Beta)\s+(\d{4}-\d{2}-\d{2})$/);
    if (!match) continue;

    const typeLabel = match[2];
    versions.push({
      id: match[1].trim(),
      date: match[3],
      type: normalizeVersionType(typeLabel),
      typeLabel
    });
  }

  if (versions.length === 0) {
    throw new Error('mcdl 没有返回可解析的版本列表');
  }

  versionCache = versions;
  versionCacheAt = now;
  return versions;
}

async function installVersion({ version, gameDir, source = 'auto', jobs = 16, onData }) {
  // 快照/远古版本的 ID 可能包含空格和括号（如 1.14.2 Pre-Release 4）。
  // spawn 使用参数数组，不经过 shell，因此允许这些字符，只排除换行和路径控制字符。
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()+\-]{0,127}$/.test(String(version || ''))) {
    throw new Error('无效的版本 ID');
  }

  const dir = gameDir || await detectGameDir();
  await fs.mkdir(dir, { recursive: true });

  const args = [
    '--install', version,
    '--dir', dir,
    '--source', source,
    '--jobs', String(Math.max(1, Math.min(64, Number(jobs) || 16)))
  ];

  await runMcdl(args, {
    onData: (text, stream) => {
      if (typeof onData === 'function') onData(text, stream);
    }
  });

  return dir;
}

function clearCaches() {
  gameDirCache = null;
  versionCache = null;
  versionCacheAt = 0;
}

module.exports = {
  MCDL_JAR,
  DEFAULT_GAME_DIR,
  LAUNCHER_HOME,
  ensureGameDir,
  detectGameDir,
  findOtherGameDirs,
  scanInstances,
  listVersions,
  installVersion,
  listJavaPaths,
  parseGameDirs,
  clearCaches
};
