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
 *
 * 拉起进程之前还有一道「关键文件完整性闸门」（见 launch-preflight.js）：
 * 缺库 / 缺 natives / 索引不对 / authlib 坏了都在这里中止，不允许带病 spawn。
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { writeFileAtomic } = require('./atomic-write');
const manifest = require('./version-manifest');
const javaRuntime = require('./java-runtime');
const preflight = require('./launch-preflight');
const gameWindow = require('./game-window');
const { createLaunchSpec } = require('./launch-spec');

const LAUNCHER_BRAND = 'MCDL Launcher';
// 版本号只从 package.json 取：覆盖式更新时只需要改那一处，
// 不会出现 -Dminecraft.launcher.version 还是上一个版本号的情况。
const LAUNCHER_VERSION = require('./package.json').version;
const DEFAULT_MEMORY_MB = 2048;
const DEFAULT_WIDTH = 854;
const DEFAULT_HEIGHT = 480;

/**
 * 等游戏窗口出现的上限。大型整合包 + 光影首次加载可能接近这个量级；
 * 超时只是「不再等」，不会判定启动失败（游戏可能还在加载）。
 */
const GAME_WINDOW_TIMEOUT_MS = gameWindow.DEFAULT_TIMEOUT_MS;

const activeLaunches = new Map();

/**
 * 启动进度：**只报告真的发生了的事**。
 *
 * 每一次回调都对应代码里一次实际动作（读了版本 JSON、选了 Java、解压了 natives、
 * 校验了多少个文件……），不写"预计会做但没做"的步骤。渲染层据此逐行显示，
 * 用户看到的每一行都能在启动日志里找到对应记录。
 *
 * state: 'running' | 'done' | 'failed'
 */
function emitStage(onStage, stage, state, detail, extra) {
  if (typeof onStage !== 'function') return;
  try {
    onStage({
      stage,
      state,
      detail: detail === undefined || detail === null ? '' : String(detail),
      at: Date.now(),
      ...(extra && typeof extra === 'object' ? extra : {})
    });
  } catch {
    // 进度回调抛错不能影响启动本身。
  }
}

/** 协作式取消：每个阶段边界都检查一次，保证「取消」在 spawn 之前真的能停下来。 */
function throwIfCancelled(signal) {
  if (signal && signal.aborted) {
    const error = new Error('已取消启动');
    error.code = 'LAUNCH_CANCELLED';
    throw error;
  }
}

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
      await writeFileAtomic(marker, new Date().toISOString(), { encoding: 'utf8' }).catch(() => {});
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
  await writeFileAtomic(marker, new Date().toISOString(), { encoding: 'utf8' }).catch(() => {});
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
    // 原子写：log4j 配置是启动关键路径，半截文件会让游戏直接起不来。
    await writeFileAtomic(file, buffer);
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

  if (account.type === 'authlib') {
    if (!account.accessToken) throw new Error('第三方账号缺少访问令牌，请重新登录');
    if (!account.serverApiRoot) throw new Error('第三方账号缺少认证服务器地址，请重新登录');
    return {
      name: account.name,
      uuid: formatUuid(account.uuid),
      accessToken: account.accessToken,
      userType: 'mojang',
      xuid: '',
      clientId: '',
      authlibApiRoot: account.serverApiRoot
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

/**
 * authlib-injector：第三方认证服务器需要这个 java agent 才能把登录请求改写到该服务器。
 * 缺失时按官方 latest.json 下载一次并缓存在数据目录。
 *
 * 这里刻意做成「宁可重新下载，也不留坏缓存」：
 *   - 已有文件先做最小体检（大小下限 + jar 的 zip 魔数 PK\x03\x04），不合格就删掉重下；
 *   - 下载走临时文件 + 校验 + rename，中断不会留下半个 jar；
 *   - latest.json 带 checksums 时按它验哈希。
 *
 * 返回 { arg, file }：arg 直接进 JVM 参数，file 交给启动前的完整性闸门。
 */
const AUTHLIB_MIN_BYTES = 1024;

async function looksLikeZipJar(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size < AUTHLIB_MIN_BYTES) return false;
    const handle = await fs.open(file, 'r');
    try {
      const header = Buffer.alloc(4);
      await handle.read(header, 0, 4, 0);
      // zip（也就是 jar）本地文件头
      return header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

function expectedAuthlibHash(meta) {
  const checksums = meta && meta.checksums;
  if (!checksums || typeof checksums !== 'object') return null;
  const raw = checksums.sha256 || checksums['sha-256'] || checksums.sha1 || checksums['sha-1'];
  if (typeof raw !== 'string' || !/^[0-9a-f]{40,64}$/i.test(raw)) return null;
  return { algorithm: raw.length === 40 ? 'sha1' : 'sha256', hex: raw.toLowerCase() };
}

async function ensureAuthlibInjector(dataDir, apiRoot, onProgress) {
  if (!apiRoot) throw new Error('第三方账号缺少认证服务器地址');

  const root = dataDir || path.join(os.homedir(), '.mcdl-launcher');
  const dir = path.join(root, 'authlib-injector');
  const jar = path.join(dir, 'authlib-injector.jar');

  let cached = true;
  if (!(await looksLikeZipJar(jar))) {
    cached = false;
    await fs.rm(jar, { force: true }).catch(() => {});
    await ensureDir(dir);
    if (typeof onProgress === 'function') onProgress('正在下载 authlib-injector …');

    const metaResponse = await fetch('https://authlib-injector.yushi.moe/artifact/latest.json', {
      signal: AbortSignal.timeout(20000)
    });
    if (!metaResponse.ok) throw new Error(`无法获取 authlib-injector 下载信息（HTTP ${metaResponse.status}）`);
    const meta = await metaResponse.json();
    const url = meta && (meta.download_url || meta.downloadUrl || meta.url);
    if (!url) throw new Error('authlib-injector 下载信息缺少地址');

    const jarResponse = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!jarResponse.ok) throw new Error(`下载 authlib-injector 失败（HTTP ${jarResponse.status}）`);
    const buffer = Buffer.from(await jarResponse.arrayBuffer());
    if (buffer.length < AUTHLIB_MIN_BYTES) throw new Error('下载到的 authlib-injector 文件异常');

    const expected = expectedAuthlibHash(meta);
    if (expected) {
      const actual = crypto.createHash(expected.algorithm).update(buffer).digest('hex');
      if (actual !== expected.hex) {
        throw new Error(
          'authlib-injector 下载校验失败（哈希不符），已中止启动。\n' +
          '可能是网络劫持或镜像缓存了旧文件，请换网络后重试。'
        );
      }
    }

    // 原子写：中断不会留下一个「看起来存在」的半个 jar（同时带 fsync）。
    await writeFileAtomic(jar, buffer);
  }

  // 官方格式：-javaagent:<jar>=<API 根地址>
  return { arg: `-javaagent:${jar}=${apiRoot}`, file: jar, apiRoot, cached };
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
 *
 * gameDir 是「基础游戏目录」：versions / libraries / assets 都从这里解析；
 * instanceDir 是「游戏真正使用的游戏目录」（版本隔离时等于
 * <gameDir>/versions/<id>），会写进 --gameDir 与 ${game_directory}，
 * 游戏也从这里读 mods / config / saves。
 * 不传 instanceDir 时两者相同（全局布局，历史行为）。
 */
async function buildLaunchPlan({ gameDir, instanceDir, instanceId, account, settings = {}, resolveJava, dataDir, onProgress, onStage, signal }) {
  const resolvedBaseDir = path.resolve(gameDir);
  const resolvedGameDir = instanceDir ? path.resolve(instanceDir) : resolvedBaseDir;
  const versionId = String(instanceId || '').trim();
  if (!versionId) throw new Error('缺少实例 ID');

  throwIfCancelled(signal);
  emitStage(onStage, 'instance', 'running');
  const chain = await manifest.loadVersionChain(resolvedBaseDir, versionId);
  if (chain.length === 0) {
    emitStage(onStage, 'instance', 'failed', `找不到 ${versionId} 的版本 JSON`);
    throw new Error(`找不到版本 ${versionId} 的版本 JSON，实例可能已损坏`);
  }

  const merged = manifest.mergeChain(chain);
  if (!merged.mainClass) throw new Error('版本 JSON 缺少 mainClass');
  emitStage(
    onStage,
    'instance',
    'done',
    chain.length > 1
      ? `${versionId} · 合并 ${chain.length} 层 inheritsFrom`
      : `${versionId} · 版本 JSON 直接可用`
  );

  const features = {
    is_demo_user: false,
    has_custom_resolution: true,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false
  };

  throwIfCancelled(signal);
  const clientJar = await manifest.resolveClientJar(resolvedBaseDir, chain, merged);
  if (clientJar.missing) {
    throw new Error(`缺少客户端 jar：${path.relative(resolvedBaseDir, clientJar.path)}，请重新安装该实例`);
  }

  // Java 先解析：它不依赖参数组装，但「版本要求哪个 Java」是用户最关心的第一件事，
  // 而且缺 Java 时没必要先去解压 natives。
  //
  // 1.16.5 及更早的官方 version.json 没有 javaVersion（PCL2 / HMCL 装的很多 Forge
  // 实例也沿用这种 JSON），这时不能按「没有要求」处理：按 Mojang 默认的 Java 8，
  // 并对旧版本封顶 8，否则会自动挑到本机最新的 Java 21，启动即
  // `Unsupported class file major version`。
  const javaRequirement = manifest.javaRequirement(merged);
  const requiredMajor = javaRequirement.required;
  const javaCeiling = javaRequirement.ceiling;
  const javaRange = javaCeiling
    ? (javaCeiling === requiredMajor ? `${requiredMajor}` : `${requiredMajor}~${javaCeiling}`)
    : `${requiredMajor}+`;

  if (typeof resolveJava !== 'function') throw new Error('缺少 Java 运行时解析器');
  throwIfCancelled(signal);
  emitStage(
    onStage,
    'java',
    'running',
    javaRequirement.declared
      ? `版本 JSON 要求 Java ${requiredMajor}${javaCeiling ? `（最高 ${javaCeiling}）` : ''}`
      : `版本 JSON 没有声明 Java 版本要求，按 Java ${requiredMajor}` +
        `${javaCeiling ? `（最高 ${javaCeiling}）` : ''} 处理`
  );
  const java = await resolveJava({
    requiredMajor,
    // 新字段：调用方（main.js / 未来的解析器）可以直接用区间信息，
    // 老调用方只读 requiredMajor 也不受影响。
    required: requiredMajor,
    ceiling: javaCeiling,
    complianceLevel: javaRequirement.complianceLevel,
    versionId
  });
  if (!java) {
    emitStage(onStage, 'java', 'failed', `没有找到 Java ${javaRange}`);
    throw new Error(
      `该版本需要 Java ${javaRange}，但本机没有找到匹配的运行时。\n` +
        '请在「设置 → Java」里指定 / 下载对应版本的 java.exe，或清空手动选择改用自动探测。'
    );
  }
  if (javaCeiling && Number(java.major) > javaCeiling) {
    // pickJava 在区间内没有可用版本时会回落到「>= required 的最小值」（例如本机只有
    // Java 17 / 21），但用更高版本跑 1.12 / 1.7 必定崩在 class 文件版本上，
    // 这里在 spawn 之前中止，而不是让游戏闪退。
    emitStage(onStage, 'java', 'failed', `Java ${java.major} 超出该版本上限 ${javaCeiling}`);
    throw new Error(
      `该版本需要 Java ${javaRange}，但本机没有找到匹配的运行时` +
        `（现在只能选到 Java ${java.major}${java.path ? `：${java.path}` : ''}）。\n` +
        `用 Java ${java.major} 运行这个版本会因 class 文件版本不兼容直接崩溃，` +
        `请在「设置 → Java」里指定 Java ${requiredMajor}。`
    );
  }
  emitStage(
    onStage,
    'java',
    'done',
    `Java ${java.major} · ${java.path}`
  );

  emitStage(onStage, 'libraries', 'running');
  const {
    classpath,
    natives,
    skipped,
    classpathArtifacts,
    nativeArtifacts
  } = manifest.collectLibraries(merged, resolvedBaseDir, features);
  const fullClasspath = [clientJar.path, ...classpath];
  const classpathSeparator = process.platform === 'win32' ? ';' : ':';
  emitStage(
    onStage,
    'libraries',
    'done',
    `${classpathArtifacts.length} 个依赖库` +
      (nativeArtifacts.length > 0 ? ` · ${nativeArtifacts.length} 个 natives 包` : '') +
      (skipped.length > 0 ? ` · ${skipped.length} 个无法解析（已排除）` : '')
  );

  const memoryMb = clampMemory(settings.memoryMb);
  const width = clampDimension(settings.width, DEFAULT_WIDTH);
  const height = clampDimension(settings.height, DEFAULT_HEIGHT);
  const nativesDir = path.join(resolvedBaseDir, 'versions', versionId, 'natives');

  throwIfCancelled(signal);
  // 解压失败会在这里抛错；「natives jar 本身缺失」交给启动前的完整性闸门统一报。
  if (natives.length > 0) {
    emitStage(onStage, 'natives', 'running');
    await prepareNatives(natives, nativesDir);
    emitStage(onStage, 'natives', 'done', `解压 ${natives.length} 个 natives 包到 versions/${versionId}/natives`);
  } else {
    emitStage(onStage, 'natives', 'done', '这个版本没有需要解压的 natives');
  }

  const loggingFile = await ensureLog4jConfig(resolvedBaseDir, merged.logging);
  if (loggingFile) emitStage(onStage, 'logging', 'done', `log4j 配置：${path.basename(loggingFile)}`);

  throwIfCancelled(signal);
  emitStage(onStage, 'assets', 'running');
  const assetsRoot = path.join(resolvedBaseDir, 'assets');
  const assetsIndexId = String((merged.assetIndex && merged.assetIndex.id) || merged.assets || 'legacy');
  const assetsIndexFile = path.join(assetsRoot, 'indexes', `${assetsIndexId}.json`);
  if (!(await manifest.exists(assetsIndexFile))) {
    emitStage(onStage, 'assets', 'failed', `缺少 assets/indexes/${assetsIndexId}.json`);
    throw new Error(`缺少资源索引 assets/indexes/${assetsIndexId}.json，请重新安装该实例`);
  }

  const isVirtual = await checkVersionType(assetsIndexFile);
  const gameAssetsDir = isVirtual ? path.join(assetsRoot, 'virtual', assetsIndexId) : assetsRoot;
  emitStage(
    onStage,
    'assets',
    'done',
    `assets/indexes/${assetsIndexId}.json` + (isVirtual ? '（旧版 virtual 布局）' : '')
  );

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
    library_directory: path.join(resolvedBaseDir, 'libraries'),
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

  emitStage(
    onStage,
    'args',
    'done',
    `classpath ${fullClasspath.length} 项 · -Xmx${memoryMb}M · ${width}×${height}` +
      (extraJvmArgs.length > 0 ? ` · 额外 JVM 参数 ${extraJvmArgs.length} 个` : '')
  );

  // 第三方认证服务器需要 authlib-injector 改写登录请求。
  let authlib = null;
  if (auth.authlibApiRoot) {
    throwIfCancelled(signal);
    emitStage(onStage, 'authlib', 'running', `认证服务器：${auth.authlibApiRoot}`);
    authlib = await ensureAuthlibInjector(dataDir, auth.authlibApiRoot, onProgress);
    jvmArgs.push(authlib.arg);
    emitStage(
      onStage,
      'authlib',
      'done',
      `${path.basename(authlib.file)} · ${authlib.cached ? '使用本地缓存' : '本次已下载并校验'}`
    );
  }

  // ---------- 启动前完整性闸门要用的文件清单 ----------
  // 顺序按「最先被 JVM 碰到」排：客户端 jar → 库 → natives → 资源索引。
  const downloads = merged.downloads || {};
  const requiredFiles = [
    {
      ...manifest.describeArtifact(downloads.client, clientJar.path, path.basename(clientJar.path)),
      kind: 'client'
    },
    ...classpathArtifacts.map((entry) => ({ ...entry, kind: 'library' })),
    ...nativeArtifacts.map((entry) => ({ ...entry, kind: 'native' })),
    {
      ...manifest.describeArtifact(merged.assetIndex, assetsIndexFile, path.basename(assetsIndexFile)),
      kind: 'assetsIndex'
    }
  ];

  if (loggingFile) {
    const logEntry = merged.logging && merged.logging.client ? merged.logging.client : {};
    requiredFiles.push({
      ...manifest.describeArtifact(logEntry.file || {}, loggingFile, path.basename(loggingFile)),
      kind: 'logConfig',
      // log4j 配置缺失不会让游戏起不来，只会在日志里安静地少掉格式。
      optional: true
    });
  }

  if (authlib) {
    requiredFiles.push({
      path: authlib.file,
      name: path.basename(authlib.file),
      kind: 'authlib',
      url: ''
    });
  }

  return {
    gameDir: resolvedGameDir,
    baseDir: resolvedBaseDir,
    isolated: resolvedGameDir !== resolvedBaseDir,
    versionId,
    javaPath: java.path,
    javaMajor: java.major,
    memoryMb,
    mainClass: merged.mainClass,
    classpath: fullClasspath,
    nativesDir,
    assetsIndexId,
    args: [...jvmArgs, merged.mainClass, ...gameArgs],
    // 闸门与「修复缺失文件」的唯一数据源。见 launch-preflight.js。
    requiredFiles,
    // 版本 JSON 里连路径都解析不出来的库：不静默丢掉了事，交给闸门/UI 说出来。
    unresolvedLibraries: skipped.slice(),
    warnings: skipped.length > 0
      ? [`${skipped.length} 个 library 在版本 JSON 里无法解析出文件路径，已从 classpath 排除（例：${skipped.slice(0, 3).join(', ')}）`]
      : []
  };
}

/** 启动前校验的哈希策略：设置里没写就是 'auto'（只哈希小文件）。 */
function hashModeFromSettings(settings) {
  if (settings && settings.verifyFiles === true) return true;
  if (settings && settings.verifyFiles === false) return false;
  return 'auto';
}

/**
 * 启动前完整性闸门：只读盘，不产生进程。
 *
 * 这是「失败路径当一等公民」的落点——在任何 spawn 之前判定必需文件是否齐全，
 * 结果是一份结构化清单（missing / corrupt / summary），调用方直接展示给用户。
 */
async function verifyLaunchPlan(plan, options = {}) {
  if (!plan || !Array.isArray(plan.requiredFiles)) {
    throw new Error('启动计划缺少必需文件清单，拒绝启动');
  }

  const result = await preflight.verifyRequiredFiles(plan.requiredFiles, {
    hashCheck: options.hashCheck === undefined ? 'auto' : options.hashCheck,
    baseDir: plan.baseDir || plan.gameDir,
    onProgress: options.onProgress
  });

  return {
    ...result,
    summary: preflight.summarizePreflight(result)
  };
}

/**
 * 修复缺失 / 损坏的必需文件，然后再校验一次。
 * 返回 before / repair / after 三段，UI 可以说清楚「修了什么、还剩什么」。
 */
async function repairLaunchPlan(plan, options = {}) {
  const hashCheck = options.hashCheck === undefined ? 'auto' : options.hashCheck;
  const before = await verifyLaunchPlan(plan, { ...options, hashCheck });
  if (before.ok) {
    return { before, repair: { repaired: [], failed: [], skipped: [] }, after: before, ok: true };
  }

  const repair = await preflight.repairRequiredFiles(before, options);
  const after = await verifyLaunchPlan(plan, { ...options, hashCheck });

  return { before, repair, after, ok: after.ok };
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
  // 保留导出以兼容旧调用方；实际换名逻辑在 launch-spec.resolveJavaExecutable 里
  // （那边会先确认 javaw.exe 真的存在，避免 spawn 直接 ENOENT）。
  if (process.platform === 'win32' && /java\.exe$/i.test(javaPath)) {
    return javaPath.replace(/java\.exe$/i, 'javaw.exe');
  }
  return javaPath;
}

/**
 * 真正启动一个实例。
 *
 * @param {AbortSignal} [options.signal] 协作式取消：每个阶段边界都会检查，
 *   取消后抛 code='LAUNCH_CANCELLED'，并且保证不会 spawn。
 * @returns {Promise<{launchId:string,pid:number|null,plan:object,logFile:string}>}
 */
async function launchInstance({ gameDir, instanceDir, instanceId, account, settings = {}, resolveJava, dataDir, onEvent, signal, launchId: providedLaunchId }) {
  // 调用方可以预先生成 launchId（这样「准备账号」这类发生在规划之前的步骤也能归到同一次启动）。
  const launchId = providedLaunchId ? String(providedLaunchId) : crypto.randomUUID();
  const emit = (kind, payload) => {
    if (typeof onEvent === 'function') onEvent(kind, payload);
  };
  const onStage = (stage) => emit('stage', { launchId, ...stage });

  // 先把 launchId 发出去：这样「取消」在规划阶段就有东西可以取消，
  // 而不是等参数都拼好、进程都要起来了才拿到 id。
  emit('begin', { launchId, instanceId, at: Date.now() });

  const plan = await buildLaunchPlan({
    gameDir,
    instanceDir,
    instanceId,
    account,
    settings,
    resolveJava,
    dataDir,
    signal,
    onStage,
    onProgress: (message) => emit('status', { message })
  });

  // ---------- 关键文件完整性闸门 ----------
  // 在拉起任何进程之前判定：缺库 / 缺 natives / 索引不对 / authlib 坏了，都在这里中止，
  // 而不是让 Java 拿着残缺的 classpath 启动、崩成一句「游戏闪退」。
  throwIfCancelled(signal);
  emitStage(onStage, 'verify', 'running', `检查 ${plan.requiredFiles.length} 项必需文件`);
  const preflightResult = await verifyLaunchPlan(plan, {
    hashCheck: hashModeFromSettings(settings),
    onProgress: (message) => emit('status', { message })
  });

  if (!preflightResult.ok) {
    emitStage(onStage, 'verify', 'failed', `${preflightResult.summary.count} 项缺失或不一致，已中止`);
    const error = new Error(preflightResult.summary.message);
    error.code = 'LAUNCH_PREFLIGHT_FAILED';
    error.details = {
      instanceId,
      versionId: plan.versionId,
      checked: preflightResult.checked,
      count: preflightResult.summary.count,
      failures: preflightResult.summary.failures,
      missing: preflightResult.missing,
      corrupt: preflightResult.corrupt,
      unresolvedLibraries: plan.unresolvedLibraries || []
    };
    if (typeof onEvent === 'function') onEvent('preflight-failed', error.details);
    throw error;
  }

  emitStage(
    onStage,
    'verify',
    'done',
    preflightResult.hashed > 0
      ? `检查 ${preflightResult.checked} 项` +
        `（${preflightResult.hashed} 项比对 SHA-1，${preflightResult.checked - preflightResult.hashed} 项检查存在与大小）`
      : `检查 ${preflightResult.checked} 项（存在性与大小：版本 JSON 没提供哈希）`
  );

  const logFile = launchLogFile(plan.gameDir);

  await ensureDir(path.dirname(logFile));
  const logStream = require('node:fs').createWriteStream(logFile, { flags: 'a' });

  // 唯一的启动规格：可执行文件与参数都过一遍形状校验并冻结，之后不再接受任何修改。
  // assertJava 是使用点授权校验——即使调用方绕过 resolveJava 直接塞一个 javaPath 进来，
  // 这里仍然会拒绝未登记的路径。
  const spec = await createLaunchSpec(plan, {
    assertJava: (javaPath) => javaRuntime.assertUsableJava(javaPath)
  });

  emit('starting', {
    launchId,
    versionId: plan.versionId,
    memoryMb: plan.memoryMb,
    warnings: plan.warnings
  });

  // 取消的最后一道门：参数已经冻结、进程还没起，这是唯一能干净停下的时机。
  throwIfCancelled(signal);

  emitStage(onStage, 'spawn', 'running', spec.executable);

  let child;
  try {
    child = spawn(spec.executable, spec.args, {
      cwd: spec.gameDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    logStream.end();
    emitStage(onStage, 'spawn', 'failed', error.message);
    throw new Error(`无法启动 Java：${error.message}`);
  }

  // spawn 的 ENOENT / EACCES 是异步 'error' 事件，try/catch 抓不到；
  // 而随后的 'close' 会带 code === null，再被 Number(null) === 0 判成「正常退出」。
  // 所以「已启动」只能以 'spawn' 事件为准，其它情况一律显式失败。
  const spawnOutcome = await new Promise((resolve) => {
    child.once('spawn', () => resolve({ ok: true }));
    child.once('error', (error) => resolve({ ok: false, error }));
  });

  if (!spawnOutcome.ok) {
    const reason = spawnOutcome.error && spawnOutcome.error.message
      ? spawnOutcome.error.message
      : '未知原因';
    logStream.write(`[${new Date().toISOString()}][sys] spawn failed: ${reason}\n`);
    logStream.end();
    emitStage(onStage, 'spawn', 'failed', reason);
    throw new Error(
      `无法启动 Java：${reason}\n` +
      `可执行文件：${spec.executable}\n` +
      '请到「设置 → Java」确认这个运行时仍然存在，或改用自动探测。'
    );
  }

  emitStage(onStage, 'spawn', 'done', `PID ${child.pid || '?'} · ${path.basename(spec.executable)}`);

  const entry = { launchId, child, plan, logFile, startedAt: Date.now(), exited: false };
  activeLaunches.set(launchId, entry);

  const writeLog = (stream, text) => {
    logStream.write(`[${new Date().toISOString()}][${stream}] ${text}`);
  };

  // ---------- 等游戏窗口真的出现 ----------
  // spawn 只代表 Java 进程被创建；游戏要加载资源 / 初始化 LWJGL / 加载模组之后才建窗口。
  // 在这之前把进度弹窗关掉，用户会以为启动失败。所以最后一步以「窗口出现」为准，
  // 等待期间用真实日志尾部更新进度（每一行都来自游戏自己的输出）。
  const spawnedAt = Date.now();
  let lastOutputLine = '';
  let windowSettled = false;
  let windowSummary = '';

  const waitSeconds = () => Math.max(1, Math.round((Date.now() - spawnedAt) / 1000));
  const waitDetail = () => {
    const tail = lastOutputLine ? ` · 最近输出：${lastOutputLine}` : '';
    return `已等待 ${waitSeconds()} 秒${tail}`;
  };

  emitStage(onStage, 'window', 'running', 'Java 已启动，等待游戏窗口出现');

  const windowTick = setInterval(() => {
    if (windowSettled) return;
    emitStage(onStage, 'window', 'running', waitDetail());
  }, 1000);
  if (typeof windowTick.unref === 'function') windowTick.unref();

  const settleWindow = (summary) => {
    if (windowSettled) return;
    windowSettled = true;
    windowSummary = summary;
    clearInterval(windowTick);
  };

  const watcher = gameWindow.watchGameWindow(child.pid, {
    timeoutMs: GAME_WINDOW_TIMEOUT_MS,
    onReady: ({ elapsedMs, viaLog }) => {
      const seconds = Math.max(1, Math.round(Number(elapsedMs || 0) / 1000));
      settleWindow(`游戏窗口已出现（用时 ${seconds} 秒${viaLog ? '，按日志判定' : ''}）`);
      emitStage(onStage, 'window', 'done', windowSummary);
      emit('window-ready', { launchId, elapsedMs: Number(elapsedMs) || 0, viaLog: Boolean(viaLog) });
    },
    onTimeout: () => {
      const seconds = Math.round(GAME_WINDOW_TIMEOUT_MS / 1000);
      settleWindow(`${seconds} 秒内没有检测到游戏窗口，游戏可能仍在加载（可打开日志查看）`);
      emitStage(onStage, 'window', 'done', windowSummary);
      emit('window-timeout', { launchId, timeoutMs: GAME_WINDOW_TIMEOUT_MS });
    },
    onGone: () => {
      // 进程没了：交给 exit 事件收尾，这里只停掉计时，不谎报成功。
      settleWindow('Java 进程已退出，游戏窗口没有出现');
      emitStage(onStage, 'window', 'failed', windowSummary);
    }
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const noteOutput = (chunk) => {
    const text = String(chunk);
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 0) {
      lastOutputLine = lines[lines.length - 1].slice(0, 120);
      // 非 Windows 平台只能靠已知日志标记判断窗口是否出现。
      watcher.noteLogLine && watcher.noteLogLine(lines[lines.length - 1]);
    }
  };

  child.stdout.on('data', (chunk) => {
    writeLog('out', chunk);
    emit('output', { launchId, stream: 'out', text: String(chunk) });
    noteOutput(chunk);
  });
  child.stderr.on('data', (chunk) => {
    writeLog('err', chunk);
    emit('output', { launchId, stream: 'err', text: String(chunk) });
    noteOutput(chunk);
  });

  child.on('error', (error) => {
    writeLog('sys', `spawn error: ${error.message}\n`);
    emit('error', { launchId, message: error.message });
  });

  child.on('close', (code, signal) => {
    entry.exited = true;
    settleWindow('Java 进程已退出');
    watcher.stop();
    logStream.write(`[${new Date().toISOString()}][sys] process exited code=${code} signal=${signal}\n`);
    logStream.end();
    emit('exit', { launchId, code, signal, uptimeMs: Date.now() - entry.startedAt });
    activeLaunches.delete(launchId);
  });

  emit('spawned', {
    launchId,
    pid: child.pid || null,
    javaPath: spec.executable,
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
    exited: entry.exited,
    // 日志窗口 / 运行栈导出要用到：日志落在哪、用哪个 JDK 起的（jstack 在同一个 bin 下）。
    logFile: entry.logFile,
    javaPath: entry.plan.javaPath
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
    javaPath: typeof value.javaPath === 'string' ? value.javaPath : '',
    // 启动前是否对所有库算 SHA-1：true / false，缺省 = 'auto'（只哈希小文件）。
    verifyFiles: typeof value.verifyFiles === 'boolean' ? value.verifyFiles : null
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
  verifyLaunchPlan,
  repairLaunchPlan,
  hashModeFromSettings,
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
