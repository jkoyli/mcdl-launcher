'use strict';

/**
 * 真实启动：把版本 JSON + 账户 + 设置拼成一条 java 命令并执行。
 *
 * 覆盖内容：
 *   - inheritsFrom 合并（加载器实例）
 *   - classpath / client jar
 *   - natives 解压（tar.exe，失败回退 PowerShell）
 *   - arguments.jvm / arguments.game 与 ${...} 占位符替换
 *   - 旧版本 minecraftArguments
 *   - log4j 配置（缺失时按版本 json 里的 URL 补一份）
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const manifest = require('./version-manifest');

const LAUNCHER_BRAND = 'MCDL Launcher';
const LAUNCHER_VERSION = '0.2.0';
const DEFAULT_MEMORY_MB = 2048;
const DEFAULT_WIDTH = 854;
const DEFAULT_HEIGHT = 480;

const activeLaunches = new Map();

function launchLogFile(gameDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(gameDir, 'logs', `mcdl-launcher-${stamp}.log`);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function splitCommandLine(input) {
  // 老版本 minecraftArguments 是单个字符串。这里按空格切分，但保留引号内的空格。
  const result = [];
  let current = '';
  let quote = '';

  for (const char of String(input)) {
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) result.push(current);
  return result;
}

function substituteArg(value, vars) {
  return String(value).replace(/\$\{([^}]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

/**
 * 把 arguments.game / arguments.jvm 里的对象条目按 rules 过滤，
 * 再展平成字符串数组。
 */
function flattenArguments(entries, features, vars) {
  const result = [];

  for (const entry of entries) {
    if (typeof entry === 'string') {
      result.push(substituteArg(entry, vars));
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (!manifest.rulesAllow(entry.rules, features)) continue;

    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const value of values) {
      if (value === undefined || value === null) continue;
      result.push(substituteArg(value, vars));
    }
  }

  return result;
}

/** 用 tar.exe 解压（Windows 10+ 自带 bsdtar，能读 zip/jar），失败回退 PowerShell。 */
async function extractZip(zipPath, destDir) {
  await ensureDir(destDir);

  const marker = path.join(destDir, `.mcdl-extract-${crypto.createHash('sha1').update(zipPath + String(await mtimeOf(zipPath))).digest('hex').slice(0, 12)}`);
  if (await manifest.exists(marker)) return;

  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

  if (await manifest.exists(tar)) {
    const ok = await runProcess(tar, ['-xf', zipPath, '-C', destDir]);
    if (ok === 0) {
      await fs.writeFile(marker, new Date().toISOString(), 'utf8').catch(() => {});
      return;
    }
  }

  const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const command = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destDir)} -Force`;
  const code = await runProcess(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
  );
  if (code !== 0) {
    throw new Error(`无法解压 natives：${path.basename(zipPath)}`);
  }
  await fs.writeFile(marker, new Date().toISOString(), 'utf8').catch(() => {});
}

async function mtimeOf(file) {
  try {
    const stat = await fs.stat(file);
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

function runProcess(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: 'ignore',
      ...options
    });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(typeof code === 'number' ? code : -1));
  });
}

async function prepareNatives(natives, nativesDir) {
  await ensureDir(nativesDir);
  const missing = [];

  for (const entry of natives) {
    if (!(await manifest.exists(entry.path))) {
      missing.push(entry.name);
      continue;
    }
    await extractZip(entry.path, nativesDir);
  }

  return missing;
}

/** log4j 配置文件：已在本地就直接用，缺失则按版本 json 里的 URL 补一份。 */
async function ensureLog4jConfig(gameDir, logging) {
  const client = logging && logging.client;
  if (!client || !client.file || !client.file.id || !client.file.url) return null;

  const dir = path.join(gameDir, 'assets', 'log_configs');
  const file = path.join(dir, String(client.file.id));
  if (await manifest.exists(file)) return file;

  try {
    await ensureDir(dir);
    const response = await fetch(client.file.url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(file, buffer);
    return file;
  } catch {
    return null;
  }
}

function offlineUuid(name) {
  // 与官方一致：md5("OfflinePlayer:<name>")，把第 7 字节高 4 位置为 3。
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-');
}

function formatUuid(raw) {
  const value = String(raw || '').replace(/-/g, '');
  if (value.length !== 32) return String(raw || '');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32)
  ].join('-');
}

/** 账户 → 启动参数需要的认证字段。 */
function buildAuthVars(account) {
  if (!account) {
    throw new Error('还没有选择账号，请先在「账户」页创建离线账号或登录微软账号');
  }

  if (account.type === 'microsoft') {
    if (!account.accessToken) throw new Error('微软账号缺少访问令牌，请重新登录');
    return {
      name: account.name,
      uuid: formatUuid(account.uuid),
      accessToken: account.accessToken,
      userType: 'msa',
      xuid: account.xuid || '',
      clientId: account.clientId || ''
    };
  }

  const name = String(account.name || '').trim();
  if (!name) throw new Error('离线账号名不能为空');
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
    throw new Error('离线账号名只能使用 1-16 位英文字母、数字或下划线，请到「账户」页重建');
  }
  return {
    name,
    uuid: account.uuid || offlineUuid(name),
    accessToken: '0',
    userType: 'legacy',
    xuid: '',
    clientId: ''
  };
}

async function checkVersionType(assetIndexFile) {
  try {
    const index = await manifest.readJson(assetIndexFile);
    return Boolean(index && index.virtual);
  } catch {
    return false;
  }
}

/**
 * 构造启动计划（不产生进程），便于测试与预览。
 */
async function buildLaunchPlan({ gameDir, instanceId, account, settings = {}, resolveJava }) {
  const resolvedGameDir = path.resolve(gameDir);
  const versionId = String(instanceId || '').trim();
  if (!versionId) throw new Error('缺少实例 ID');

  const chain = await manifest.loadVersionChain(resolvedGameDir, versionId);
  if (chain.length === 0) {
    throw new Error(`找不到版本 ${versionId} 的版本 JSON，实例可能已损坏`);
  }

  const merged = manifest.mergeChain(chain);
  if (!merged.mainClass) throw new Error('版本 JSON 缺少 mainClass');

  const features = {
    is_demo_user: false,
    has_custom_resolution: true,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false
  };

  const clientJar = await manifest.resolveClientJar(resolvedGameDir, chain, merged);
  if (clientJar.missing) {
    throw new Error(`缺少客户端 jar：${path.relative(resolvedGameDir, clientJar.path)}，请重新安装该实例`);
  }

  const { classpath, natives, skipped } = manifest.collectLibraries(merged, resolvedGameDir, features);
  const fullClasspath = [clientJar.path, ...classpath];
  const classpathSeparator = process.platform === 'win32' ? ';' : ':';
  const missingLibraries = [];
  for (const entry of fullClasspath) {
    if (!(await manifest.exists(entry))) missingLibraries.push(path.basename(entry));
  }

  const memoryMb = clampMemory(settings.memoryMb);
  const width = clampDimension(settings.width, DEFAULT_WIDTH);
  const height = clampDimension(settings.height, DEFAULT_HEIGHT);
  const nativesDir = path.join(resolvedGameDir, 'versions', versionId, 'natives');
  const missingNatives = await prepareNatives(natives, nativesDir);

  const loggingFile = await ensureLog4jConfig(resolvedGameDir, merged.logging);

  const assetsRoot = path.join(resolvedGameDir, 'assets');
  const assetsIndexId = String((merged.assetIndex && merged.assetIndex.id) || merged.assets || 'legacy');
  const assetsIndexFile = path.join(assetsRoot, 'indexes', `${assetsIndexId}.json`);
  if (!(await manifest.exists(assetsIndexFile))) {
    throw new Error(`缺少资源索引 assets/indexes/${assetsIndexId}.json，请重新安装该实例`);
  }

  const isVirtual = await checkVersionType(assetsIndexFile);
  const gameAssetsDir = isVirtual ? path.join(assetsRoot, 'virtual', assetsIndexId) : assetsRoot;

  const auth = buildAuthVars(account);
  const extraJvmArgs = Array.isArray(settings.extraJvmArgs)
    ? settings.extraJvmArgs
    : splitCommandLine(settings.jvmArgs || '').filter(Boolean);

  const vars = {
    auth_player_name: auth.name,
    auth_uuid: auth.uuid,
    auth_access_token: auth.accessToken,
    auth_session: `token:${auth.accessToken}:${auth.uuid}`,
    auth_xuid: auth.xuid,
    clientid: auth.clientId,
    user_type: auth.userType,
    user_properties: '{}',
    version_name: versionId,
    version_type: merged.type || 'release',
    game_directory: resolvedGameDir,
    assets_root: assetsRoot,
    game_assets: gameAssetsDir,
    assets_index_name: assetsIndexId,
    natives_directory: nativesDir,
    launcher_name: LAUNCHER_BRAND,
    launcher_version: LAUNCHER_VERSION,
    classpath: fullClasspath.join(classpathSeparator),
    classpath_separator: classpathSeparator,
    library_directory: path.join(resolvedGameDir, 'libraries'),
    resolution_width: String(width),
    resolution_height: String(height),
    quickPlayPath: '',
    quickPlaySingleplayer: '',
    quickPlayMultiplayer: '',
    quickPlayRealms: ''
  };

  const memoryArgs = [`-Xmx${memoryMb}M`];
  const baseJvmArgs = [
    ...memoryArgs,
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    `-Dminecraft.launcher.brand=${LAUNCHER_BRAND}`,
    `-Dminecraft.launcher.version=${LAUNCHER_VERSION}`
  ];

  if (loggingFile) {
    baseJvmArgs.push(`-Dlog4j.configurationFile=${loggingFile}`);
  }

  let jvmArgs;
  if (merged.arguments.jvm.length > 0) {
    // 1.13+ 的 json 已经自带 -Djava.library.path 和 -cp，
    // 其中也会包含 -Dminecraft.launcher.*，这里避免重复传同一批 -D。
    const fromJson = flattenArguments(merged.arguments.jvm, features, vars);
    const jsonKeys = new Set(
      fromJson
        .map((arg) => {
          const match = String(arg).match(/^-D([^=]+)=/);
          return match ? match[1] : null;
        })
        .filter(Boolean)
    );

    jvmArgs = [
      ...baseJvmArgs.filter((arg) => {
        const match = String(arg).match(/^-D([^=]+)=/);
        return !match || !jsonKeys.has(match[1]);
      }),
      ...extraJvmArgs,
      ...fromJson
    ];
  } else {
    jvmArgs = [
      ...baseJvmArgs,
      ...extraJvmArgs,
      `-Djava.library.path=${nativesDir}`,
      '-cp',
      vars.classpath
    ];
  }

  let gameArgs;
  if (merged.arguments.game.length > 0) {
    gameArgs = flattenArguments(merged.arguments.game, features, vars);
  } else if (merged.minecraftArguments) {
    gameArgs = splitCommandLine(merged.minecraftArguments).map((arg) => substituteArg(arg, vars));
  } else {
    throw new Error('版本 JSON 既没有 arguments.game 也没有 minecraftArguments');
  }

  const requiredMajor = merged.javaVersion && merged.javaVersion.majorVersion
    ? Number(merged.javaVersion.majorVersion)
    : 0;

  if (typeof resolveJava !== 'function') throw new Error('缺少 Java 运行时解析器');
  const java = await resolveJava({ requiredMajor, versionId });
  if (!java) {
    throw new Error(
      requiredMajor
        ? `没有找到可用的 Java ${requiredMajor} 运行时，请在设置里指定 java.exe`
        : '没有找到可用的 Java 运行时，请在设置里指定 java.exe'
    );
  }

  return {
    gameDir: resolvedGameDir,
    versionId,
    javaPath: java.path,
    javaMajor: java.major,
    memoryMb,
    mainClass: merged.mainClass,
    classpath: fullClasspath,
    nativesDir,
    assetsIndexId,
    args: [...jvmArgs, merged.mainClass, ...gameArgs],
    warnings: [
      ...(missingLibraries.length > 0
        ? [`${missingLibraries.length} 个依赖库文件缺失，可能无法启动（例：${missingLibraries.slice(0, 3).join(', ')}）`]
        : []),
      ...(missingNatives.length > 0
        ? [`${missingNatives.length} 个 natives 包缺失（例：${missingNatives.slice(0, 3).join(', ')}）`]
        : []),
      ...(skipped.length > 0 ? [`${skipped.length} 个 library 无法解析路径`] : [])
    ]
  };
}

function clampMemory(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_MEMORY_MB;
  return Math.max(512, Math.min(32768, Math.round(number)));
}

function clampDimension(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(320, Math.min(7680, Math.round(number)));
}

function javaExecutableForSpawn(javaPath) {
  // 用 javaw.exe 启动可以避免弹出控制台窗口；stdout/stderr 管道仍然可用。
  if (process.platform === 'win32' && /java\.exe$/i.test(javaPath)) {
    return javaPath.replace(/java\.exe$/i, 'javaw.exe');
  }
  return javaPath;
}

/**
 * 真正启动一个实例。
 * @returns {Promise<{launchId:string,pid:number|null,plan:object,logFile:string}>}
 */
async function launchInstance({ gameDir, instanceId, account, settings = {}, resolveJava, onEvent }) {
  const plan = await buildLaunchPlan({ gameDir, instanceId, account, settings, resolveJava });
  const launchId = crypto.randomUUID();
  const logFile = launchLogFile(plan.gameDir);

  await ensureDir(path.dirname(logFile));
  const logStream = require('node:fs').createWriteStream(logFile, { flags: 'a' });

  const executable = javaExecutableForSpawn(plan.javaPath);
  const emit = (kind, payload) => {
    if (typeof onEvent === 'function') onEvent(kind, payload);
  };

  emit('starting', {
    launchId,
    versionId: plan.versionId,
    memoryMb: plan.memoryMb,
    warnings: plan.warnings
  });

  let child;
  try {
    child = spawn(executable, plan.args, {
      cwd: plan.gameDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    logStream.end();
    throw new Error(`无法启动 Java：${error.message}`);
  }

  const entry = { launchId, child, plan, logFile, startedAt: Date.now(), exited: false };
  activeLaunches.set(launchId, entry);

  const writeLog = (stream, text) => {
    logStream.write(`[${new Date().toISOString()}][${stream}] ${text}`);
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    writeLog('out', chunk);
    emit('output', { launchId, stream: 'out', text: String(chunk) });
  });
  child.stderr.on('data', (chunk) => {
    writeLog('err', chunk);
    emit('output', { launchId, stream: 'err', text: String(chunk) });
  });

  child.on('error', (error) => {
    writeLog('sys', `spawn error: ${error.message}\n`);
    emit('error', { launchId, message: error.message });
  });

  child.on('close', (code, signal) => {
    entry.exited = true;
    logStream.write(`[${new Date().toISOString()}][sys] process exited code=${code} signal=${signal}\n`);
    logStream.end();
    emit('exit', { launchId, code, signal, uptimeMs: Date.now() - entry.startedAt });
    activeLaunches.delete(launchId);
  });

  emit('spawned', {
    launchId,
    pid: child.pid || null,
    javaPath: plan.javaPath,
    javaMajor: plan.javaMajor,
    logFile
  });

  return { launchId, pid: child.pid || null, plan, logFile };
}

async function stopLaunch(launchId) {
  const entry = activeLaunches.get(launchId);
  if (!entry) return false;
  try {
    entry.child.kill();
  } catch {
    return false;
  }
  return true;
}

function listActiveLaunches() {
  return Array.from(activeLaunches.values()).map((entry) => ({
    launchId: entry.launchId,
    pid: entry.child.pid || null,
    versionId: entry.plan.versionId,
    startedAt: entry.startedAt,
    exited: entry.exited
  }));
}

/** 启动器默认设置：内存 / 窗口尺寸 / 额外 JVM 参数。 */
function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    memoryMb: clampMemory(value.memoryMb),
    width: clampDimension(value.width, DEFAULT_WIDTH),
    height: clampDimension(value.height, DEFAULT_HEIGHT),
    jvmArgs: typeof value.jvmArgs === 'string' ? value.jvmArgs : '',
    extraJvmArgs: Array.isArray(value.extraJvmArgs) ? value.extraJvmArgs.map(String) : [],
    javaPath: typeof value.javaPath === 'string' ? value.javaPath : ''
  };
}

function defaultMemoryMb() {
  const total = Math.round(os.totalmem() / (1024 * 1024));
  if (total >= 16384) return 4096;
  if (total >= 8192) return 3072;
  return DEFAULT_MEMORY_MB;
}

module.exports = {
  buildLaunchPlan,
  launchInstance,
  stopLaunch,
  listActiveLaunches,
  normalizeSettings,
  defaultMemoryMb,
  offlineUuid,
  formatUuid,
  splitCommandLine,
  substituteArg,
  DEFAULT_MEMORY_MB,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT
};
