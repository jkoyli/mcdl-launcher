'use strict';

/**
 * 本机 Java 运行时探测。
 *
 * 只做两件事：
 *   1. 找出可能存在的 java.exe（环境变量 / PATH / 常见安装目录 / mcdl --list-java）
 *   2. 真正执行一次 `java -XshowSettings:properties -version`，读出真实版本和架构
 *
 * 不解析 mcdl 的中文表格文本（那会依赖输出格式和编码），只把它当成
 * “还有哪些绝对路径值得试一下”的线索。
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const { writeFileAtomic } = require('./atomic-write');
const { assertJavaExecutableShape } = require('./launch-spec');

const IS_WINDOWS = process.platform === 'win32';
const JAVA_EXE = IS_WINDOWS ? 'java.exe' : 'java';
const PROBE_TIMEOUT = 8000;

// 常见 JDK/JRE 安装根目录。每项只扫一层子目录，例如
//   C:\Program Files\Java\jdk1.8.0_202\bin\java.exe
//   C:\Program Files\Eclipse Adoptium\jdk-25.0.4.101-hotspot\bin\java.exe
const SCAN_ROOTS = [
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Java'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Eclipse Adoptium'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Eclipse Foundation'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'BellSoft'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Zulu'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Semeru'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Amazon Corretto'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'AdoptOpenJDK'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Common Files', 'Oracle', 'Java'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Java'),
  process.env['ProgramFiles(x86)'] &&
    path.join(process.env['ProgramFiles(x86)'], 'Common Files', 'Oracle', 'Java'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft')
].filter(Boolean);

let cache = null;

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: options.timeout || PROBE_TIMEOUT,
      maxBuffer: 1024 * 1024,
      ...options
    }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 从 `java -XshowSettings:properties -version` 的输出里读出关键属性。 */
function parseProperties(output) {
  const props = {};
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s{2,}([A-Za-z0-9._-]+)\s*=\s*(.*?)\s*$/);
    if (match) props[match[1]] = match[2];
  }
  return props;
}

function normalizeMajor(specification, version) {
  const spec = String(specification || '').trim();
  if (spec) {
    // 1.8 / 9 / 17 / 21
    const parts = spec.split('.');
    if (parts[0] === '1' && parts[1]) return Number(parts[1]);
    return Number(parts[0]);
  }

  const raw = String(version || '').trim();
  if (!raw) return 0;
  if (raw.startsWith('1.')) return Number(raw.split('.')[1]) || 0;
  return Number(raw.split(/[.+-]/)[0]) || 0;
}

async function probe(javaPath) {
  try {
    // -XshowSettings 会把系统属性写到 stderr，-version 保证即使属性输出被裁剪也能拿到版本。
    const { stdout, stderr } = await execFileAsync(
      javaPath,
      ['-XshowSettings:properties', '-version']
    );
    const props = parseProperties(stderr + '\n' + stdout);
    const version = props['java.version'] || props['java.runtime.version'] || '';
    const specification = props['java.specification.version'] || '';
    const major = normalizeMajor(specification, version);
    if (!major) return null;

    const osArch = props['os.arch'] || '';
    const bitness = /\b(x86|i386|i686)\b/i.test(osArch) ? 32 : 64;
    const vendor =
      props['java.vendor'] ||
      (props['java.vm.version'] && props['java.vm.version'] !== version ? props['java.vm.name'] : '') ||
      '';

    return {
      path: javaPath,
      major,
      version: version || specification,
      arch: osArch || (IS_WINDOWS ? 'amd64' : process.arch),
      bitness,
      vendor: String(vendor).trim()
    };
  } catch {
    return null;
  }
}

async function isFile(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readDirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function javaCandidatesInHome(home) {
  if (!home) return [];
  return [
    path.join(home, 'bin', JAVA_EXE),
    // 一些老 JDK 的 JRE 子目录
    path.join(home, 'jre', 'bin', JAVA_EXE)
  ];
}

/**
 * 内置 JRE。electron-builder 把 jre/ 通过 extraResources 放到 resources 下：
 *   打包态：<resources>/jre/bin/java.exe
 *   开发态：electron/jre/bin/java.exe（scripts/fetch-jre.js 的落点）
 *
 * 只有文件**真实存在**才算可用——dist 里现在放的是只有一个 README.txt 的占位目录，
 * 那种情况必须返回 null，否则选择器会把一个不存在的 java.exe 当成候选。
 *
 * @param {{resourcesPath?:string, devRoot?:string}} [options] 测试可注入根目录
 * @returns {string|null}
 */
function bundledJava(options = {}) {
  const resourcesPath = options.resourcesPath !== undefined
    ? String(options.resourcesPath || '')
    : String(process.resourcesPath || '');
  const devRoot = options.devRoot !== undefined ? String(options.devRoot || '') : __dirname;

  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'jre', 'bin', JAVA_EXE));
  if (devRoot) candidates.push(path.join(devRoot, 'jre', 'bin', JAVA_EXE));

  for (const candidate of candidates) {
    try {
      if (fsSync.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // 不存在：继续找下一个
    }
  }
  return null;
}

/** 只取 MCDL_JAVA（直接给 java.exe，或给 JDK 根目录）。 */
function configuredCandidates() {
  if (!process.env.MCDL_JAVA) return [];
  const configured = path.resolve(process.env.MCDL_JAVA);
  return /\.exe$/i.test(configured) || path.basename(configured) === JAVA_EXE
    ? [configured]
    : javaCandidatesInHome(configured);
}

/** JAVA_HOME 上的 java。 */
function javaHomeCandidates() {
  return process.env.JAVA_HOME ? javaCandidatesInHome(process.env.JAVA_HOME) : [];
}

/** PATH 上的 java（PATH 里通常就是 <jdk>\bin）。 */
function pathCandidates() {
  const result = [];
  const pathDirs = String(process.env.PATH || '').split(IS_WINDOWS ? ';' : ':');
  for (const dir of pathDirs) {
    if (!dir) continue;
    const trimmed = dir.replace(/^"|"$/g, '').trim();
    if (!trimmed) continue;
    result.push(path.join(trimmed, JAVA_EXE));
  }
  return result;
}

/** 环境变量 + PATH 上的 java。 */
async function environmentCandidates() {
  return [...configuredCandidates(), ...javaHomeCandidates(), ...pathCandidates()];
}

/** 扫描常见安装目录，返回 <root>\<子目录>\bin\java.exe。 */
async function scannedCandidates() {
  const result = [];

  for (const root of SCAN_ROOTS) {
    for (const entry of await readDirSafe(root)) {
      if (!entry.isDirectory()) continue;
      result.push(...javaCandidatesInHome(path.join(root, entry.name)));
    }
  }

  // Oracle 的 Java 8 安装在 <root>\jre 下，注册表来源也常见于 <root>\jre\bin。
  for (const root of SCAN_ROOTS) {
    result.push(...javaCandidatesInHome(root));
  }

  return result;
}

/**
 * mcdl 自带注册表级探测。这里只提取其中的绝对路径，
 * 不解析表格里的版本号 / 架构文字。
 */
async function mcdlCandidates(mcdlService) {
  if (!mcdlService) return [];
  try {
    const output = await mcdlService.listJavaPaths();
    return output;
  } catch {
    return [];
  }
}

function dedupe(paths) {
  const seen = new Set();
  const result = [];

  for (const candidate of paths) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const key = IS_WINDOWS ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }

  return result;
}

/**
 * 跑「工具类」Java 程序（当前只有 mcdl.jar）所需的最低主版本。
 *
 * mcdl.jar 用 JDK 17 编译（class file 61）。拿 Java 8 去跑会在
 * `LauncherHelper.checkAndLoadMain` 加载主类时失败、退出码 1，
 * 而界面上只剩一句「无法读取版本列表」。所以这条链必须按 ≥17 过滤，
 * 不能像「启动游戏」那样按版本 JSON 的要求挑（游戏本身可能就是要 Java 8）。
 */
const TOOLS_MIN_JAVA_MAJOR = 17;

/** 探测某个 java 的主版本；探测不出来返回 0。 */
async function javaMajorOf(javaPath) {
  const info = await probe(javaPath).catch(() => null);
  return info && info.major ? info.major : 0;
}

/**
 * 给"只需要一个能跑 JVM 的子进程"的调用方（mcdl-service）找一个 java。
 *
 * 与 `pickJava`（按游戏版本要求挑）不同，这里的约束是「版本够新」：
 * 优先级 MCDL_JAVA（显式指定，信任用户）→ 内置 JRE → 缓存里 ≥17 的运行时
 * （取最高主版本）→ JAVA_HOME → 目录扫描 → PATH。
 *
 * 注意：缓存（java-runtimes.json）里是**扫描顺序**，老机器上往往是
 * 8 → 17 → 21，直接取 `[0]` 会拿到 Java 8 —— 这正是 mcdl 起不来的原因。
 *
 * `candidates` 是给测试 / 特殊调用方的显式注入：给了就只在这些路径里找
 * （不再按版本过滤，调用方自己负责）。
 *
 * @param {{resourcesPath?:string, devRoot?:string, candidates?:string[], minMajor?:number}} [options]
 * @returns {Promise<string|null>}
 */
async function findJavaForTools(options = {}) {
  if (Array.isArray(options.candidates)) {
    for (const candidate of dedupe(options.candidates)) {
      if (await isFile(candidate)) return candidate;
    }
    return null;
  }

  const minMajor = Number(options.minMajor) || TOOLS_MIN_JAVA_MAJOR;
  // 测试 / 特殊调用方可以注入一份缓存，避免读盘或避开本机真实 Java。
  const cached = Array.isArray(options.cache) ? options.cache : cache;

  // 1) 显式配置：用户说用哪个就用哪个（只要求文件存在）。
  for (const candidate of dedupe(configuredCandidates())) {
    if (await isFile(candidate)) return candidate;
  }

  // 2) 内置 JRE（`npm run fetch:jre` 装的是 JRE 21），天然满足要求。
  const bundled = bundledJava(options);
  if (bundled && await isFile(bundled)) return bundled;

  // 3) 缓存里主版本 ≥ minMajor 的：取最高的那个（不同 JDK 都可能存在多个）。
  if (Array.isArray(cached) && cached.length > 0) {
    const known = cached
      .filter((item) => item && item.path && Number(item.major) >= minMajor)
      .sort((a, b) => Number(b.major) - Number(a.major));
    for (const item of known) {
      if (await isFile(item.path)) return item.path;
    }
  }

  // 4) JAVA_HOME：能探测出版本就按版本判断，探测不出就信它。
  for (const candidate of dedupe(javaHomeCandidates())) {
    if (!(await isFile(candidate))) continue;
    const major = await javaMajorOf(candidate);
    if (!major || major >= minMajor) return candidate;
  }

  // 5) 最后才做目录扫描 / 走 PATH：这两步最慢，也最不可控，逐个探测版本。
  for (const candidate of dedupe(await scannedCandidates().catch(() => []))) {
    if (!(await isFile(candidate))) continue;
    if ((await javaMajorOf(candidate)) >= minMajor) return candidate;
  }
  for (const candidate of dedupe(pathCandidates())) {
    if (!(await isFile(candidate))) continue;
    if ((await javaMajorOf(candidate)) >= minMajor) return candidate;
  }

  return null;
}

/**
 * 扫描本机所有可用的 Java。
 * @returns {Promise<Array<{path:string,major:number,version:string,arch:string,bitness:number,vendor:string,source?:string}>>}
 */
async function scanJavaRuntimes(mcdlService) {
  const bundled = bundledJava();
  const candidates = dedupe([
    // 内置 JRE 排第一：本机没装 Java 时它是唯一的可用运行时，
    // pickJava 能不能选到它，取决于它有没有出现在这份候选里。
    ...(bundled ? [bundled] : []),
    ...(await environmentCandidates()),
    ...(await scannedCandidates()),
    ...(await mcdlCandidates(mcdlService))
  ]);

  const runtimes = [];
  const seenReal = new Set();

  for (const candidate of candidates) {
    if (!(await isFile(candidate))) continue;

    let realKey = candidate;
    try {
      realKey = await fs.realpath(candidate);
    } catch {
      // 忽略
    }
    const key = IS_WINDOWS ? realKey.toLowerCase() : realKey;
    if (seenReal.has(key)) continue;
    seenReal.add(key);

    const info = await probe(candidate);
    if (!info) continue;
    // 标记来源，UI / 日志能区分"安装包自带的 JRE"和用户自己的 JDK。
    if (bundled && candidate === bundled) info.source = 'bundled';
    runtimes.push(info);
  }

  runtimes.sort((a, b) => a.major - b.major || a.path.localeCompare(b.path));
  return runtimes;
}

/**
 * 扫描本机 Java（带磁盘缓存）。
 *
 * `mcdl --list-java` 会查注册表并逐个探测 JVM，一次要十几秒，
 * 所以结果缓存到数据目录，24 小时内直接复用；force 可强制重扫。
 */
async function getJavaRuntimes(mcdlService, options = {}) {
  if (cache && !options.force) return cache;

  const cacheFile = options.cacheFile;
  if (cacheFile && !options.force) {
    try {
      const stat = await fs.stat(cacheFile);
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
        const parsed = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
        if (Array.isArray(parsed.runtimes) && parsed.runtimes.length > 0) {
          // 24h 缓存可能是在「还没有内置 JRE」时写下的。内置 JRE 是随包分发的，
          // 只要它出现了就必须进候选，否则 pickJava 一辈子选不到它。
          const bundled = bundledJava();
          const cachedPaths = new Set(
            parsed.runtimes.map((item) => (
              IS_WINDOWS ? String(item && item.path || '').toLowerCase() : String(item && item.path || '')
            ))
          );
          const hasBundled = !bundled || cachedPaths.has(
            IS_WINDOWS ? path.resolve(bundled).toLowerCase() : path.resolve(bundled)
          );
          if (hasBundled) {
            cache = parsed.runtimes;
            return cache;
          }
        }
      }
    } catch {
      // 没有缓存或缓存损坏：继续扫描
    }
  }

  cache = await scanJavaRuntimes(mcdlService);

  if (cacheFile && cache.length > 0) {
    try {
      // 原子写：缓存被强杀截断会变成非法 JSON，下次「扫描」直接报错（虽然可重建）。
      await writeFileAtomic(cacheFile, JSON.stringify({
        scannedAt: new Date().toISOString(),
        runtimes: cache
      }, null, 2), { encoding: 'utf8' });
    } catch {
      // 缓存写不进去不影响使用
    }
  }

  return cache;
}

function versionKey(version) {
  return String(version || '')
    .split(/[._+-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersion(a, b) {
  const left = versionKey(a);
  const right = versionKey(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// 没有 javaVersion 的旧版本（1.12.2 / 1.7.10 / 大量 Forge 实例）按 Java 8 处理。
const DEFAULT_JAVA_MAJOR = 8;

/**
 * 归一化 pickJava 的参数。支持三种写法（向后兼容旧调用）：
 *   pickJava(runtimes, 17)                       // 老签名：只给最低版本
 *   pickJava(runtimes, 17, 21)                   // 额外给上限
 *   pickJava(runtimes, { required: 8, ceiling: 8 })
 *
 * 上限缺省规则与 Mojang 规范一致：
 *   - required <= 8 → 上限 8（Java 9+ 跑 1.12 / 1.7 必炸）；
 *   - required >= 9 → 不设上限。
 * required 为 0（老调用表示「没有版本要求」）时不设上限，保持旧行为。
 */
function normalizeJavaRequirement(requiredMajorOrOptions, maybeCeiling) {
  const options = requiredMajorOrOptions && typeof requiredMajorOrOptions === 'object'
    ? requiredMajorOrOptions
    : {
      required: requiredMajorOrOptions,
      ceiling: maybeCeiling
    };

  const rawRequired = options.required !== undefined ? options.required : options.requiredMajor;
  const required = Math.max(0, Math.floor(Number(rawRequired) || 0));

  let ceiling = null;
  const rawCeiling = options.ceiling !== undefined ? options.ceiling : options.maxMajor;
  if (rawCeiling !== undefined && rawCeiling !== null && rawCeiling !== '') {
    const parsed = Math.floor(Number(rawCeiling));
    if (Number.isFinite(parsed) && parsed > 0) ceiling = parsed;
  }
  if (ceiling === null && required > 0 && required <= DEFAULT_JAVA_MAJOR) {
    ceiling = DEFAULT_JAVA_MAJOR;
  }

  return { required, ceiling };
}

/**
 * 按版本 JSON 的 Java 要求选一个运行时。
 *
 * 参数：`pickJava(runtimes, required)`（旧签名）、`pickJava(runtimes, required, ceiling)`
 * 或 `pickJava(runtimes, { required, ceiling })`。
 *
 * 规则：
 *   - 64 位优先，其次版本号更高（保持历史排序语义）；
 *   - 优先主版本号完全等于 required 的；
 *   - 否则在 [required, ceiling] 内取主版本最小的；
 *   - 区间内没有则回落到「>= required 的最小值」；
 *   - 仍没有（或 required 高于本机所有版本）返回 null，由上层报错，
 *     不再硬塞一个可能直接崩的 JVM。
 *   - required 缺省为 0 时保持旧行为：返回排序后的第一个（最高版本），
 *     供不关心版本的旧调用方使用。
 *
 * @param {Array<{major:number,version:string,bitness?:number,path:string}>} runtimes
 * @param {number|{required?:number,ceiling?:number|null}} requiredMajorOrOptions
 * @param {number|null} [maybeCeiling]
 */
function pickJava(runtimes, requiredMajorOrOptions, maybeCeiling) {
  if (!Array.isArray(runtimes) || runtimes.length === 0) return null;
  const { required, ceiling } = normalizeJavaRequirement(requiredMajorOrOptions, maybeCeiling);

  const sorted = runtimes.slice().sort((a, b) => (
    (b.bitness || 0) - (a.bitness || 0) ||
    compareVersion(b.version, a.version) ||
    a.path.localeCompare(b.path)
  ));

  if (!required) return sorted[0];

  const exact = sorted.filter((item) => item.major === required);
  if (exact.length > 0) return exact[0];

  const minMajorOf = (list) => Math.min(...list.map((item) => item.major));
  const firstOfMinMajor = (list) => {
    const minMajor = minMajorOf(list);
    return list.find((item) => item.major === minMajor) || list[0];
  };

  if (ceiling !== null && ceiling >= required) {
    const inRange = sorted.filter((item) => item.major >= required && item.major <= ceiling);
    if (inRange.length > 0) return firstOfMinMajor(inRange);
  }

  const atLeast = sorted.filter((item) => item.major >= required);
  if (atLeast.length > 0) return firstOfMinMajor(atLeast);

  return null;
}

function clearCache() {
  cache = null;
}

// ---------------------------------------------------------------------
// Java 授权表（javaPath 的可信边界）
// ---------------------------------------------------------------------
//
// 为什么不是"入口白名单"：javaPath 只要是渲染进程能写的一个字符串，
// `probe()` / `spawn()` 里就有一个"任意可执行文件"的执行点（F1）。
// 真正的边界在使用点——启动时把路径换成真实路径，再查这张表。
//
// 指纹的时机与失效策略
// --------------------
// 时机（唯一会执行"尚未授权"的可执行文件的两个时刻）：
//   1) settings:pick-java —— 用户通过系统对话框显式选择。对话框返回值由主进程拿到，
//      渲染进程伪造不了"用户真的选过"；随后 realpath + stat + probe('-version') 各一次，
//      确认它真是 JVM 并读出 major，成功后连同指纹写入授权表。
//   2) 启动器自己枚举出来的 Java（JAVA_HOME / PATH / MCDL_JAVA / SCAN_ROOTS / 上次扫描结果）——
//      这些本来就是启动器探过的，保存设置时 probe 一次入表。
//
// 指纹：{ size, mtimeMs }。授权的是"这个文件"，不是"这个路径"——
// 任何一项变化都视为授权作废（防止"授权 java.exe 之后把文件替换成别的 exe"）。
//
// 失效：
//   - 作废后**不自动重跑 probe**（那等于执行一个可能已被替换的二进制），
//     直接报错要求用户重新选择；
//   - settings.json 里保存 javaIdentity；启动时只做指纹比对（这是"不执行也能续授权"的
//     唯一途径），对不上就丢弃记录并提示重选；
//   - 启动过程本身不触发 probe：buildLaunchPlan 用的 info 来自授权记录缓存。
//
// 使用点：launch-spec.createLaunchSpec 通过 assertJava 回调校验（见 launch.js），
// 新增调用方也绕不过这张表。

const authorizedJava = new Map(); // realpath(lower) -> { real, size, mtimeMs, major, version, at }

function javaKey(realPath) {
  return IS_WINDOWS ? String(realPath).toLowerCase() : String(realPath);
}

function fingerprintOf(stat) {
  return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

function sameFingerprint(record, stat) {
  if (!record || !stat) return false;
  const current = fingerprintOf(stat);
  return record.size === current.size && record.mtimeMs === current.mtimeMs;
}

/**
 * 这个可执行文件是不是"启动器自己枚举出来的 Java"？
 *
 * 比的是**可执行文件的真实路径**，不是它所在目录：Oracle 的 JDK 会建
 * `java8path_target_<n>` 这类 junction 目录，realpath 之后目录名整个变了，
 * 用目录白名单会误伤正常安装。
 */
async function isEnumeratorProvidedJava(realTarget) {
  // 内置 JRE 也是启动器自己枚举出来的（它随安装包分发），
  // 用户把它选为默认 Java 时不应该被"未授权"挡住。
  const bundled = bundledJava();
  const candidates = dedupe([
    ...(bundled ? [bundled] : []),
    ...(await environmentCandidates()),
    ...(await scannedCandidates()),
    ...(Array.isArray(cache) ? cache.map((item) => item && item.path) : [])
  ]);

  const key = javaKey;
  const target = key(realTarget);

  for (const candidate of candidates) {
    const real = await fs.realpath(candidate).catch(() => null);
    if (real && key(real) === target) return true;
  }
  return false;
}

/**
 * 查授权表（不执行任何程序）。
 * @returns {Promise<{state:'ok'|'missing'|'stale', record?:object}>}
 *   ok      —— 已授权且指纹一致
 *   missing —— 从没登记过
 *   stale   —— 登记过，但文件被替换 / 改动过
 */
async function lookupAuthorization(realPath) {
  const record = authorizedJava.get(javaKey(realPath));
  if (!record) return { state: 'missing' };

  const stat = await fs.stat(realPath).catch(() => null);
  if (!sameFingerprint(record, stat)) {
    authorizedJava.delete(javaKey(realPath));
    return { state: 'stale' };
  }
  return { state: 'ok', record };
}

/** 授权记录（不含多余信息），用于写入 settings.json。 */
async function javaAuthorization(javaPath) {
  try {
    const real = await fs.realpath(await assertJavaExecutableShape(javaPath));
    const found = await lookupAuthorization(real);
    if (found.state !== 'ok') return null;
    const { record } = found;
    return { real: record.real, size: record.size, mtimeMs: record.mtimeMs, major: record.major };
  } catch {
    return null;
  }
}

/** 执行一次 probe 并登记授权。只应在 pick 流程或"启动器自己枚举到的路径"上调用。 */
async function registerJava(javaPath) {
  const resolved = await assertJavaExecutableShape(javaPath);
  const real = await fs.realpath(resolved);
  const stat = await fs.stat(real);

  const info = await probe(real);
  if (!info || !info.major) {
    throw new Error(`这个程序没有返回 Java 版本信息，不是可用的 Java 运行时：${real}`);
  }

  const record = {
    real,
    ...fingerprintOf(stat),
    major: info.major,
    version: info.version,
    at: new Date().toISOString()
  };
  authorizedJava.set(javaKey(real), record);
  return { info: { ...info, path: real }, record };
}

/** 启动时从 settings.json 的 javaIdentity 恢复授权（只比对指纹，不执行）。 */
async function restoreJavaAuthorization(identity) {
  if (!identity || typeof identity !== 'object' || !identity.real) return null;
  try {
    const stat = await fs.stat(identity.real);
    if (identity.size !== stat.size || identity.mtimeMs !== Math.round(stat.mtimeMs)) return null;
    const record = {
      real: identity.real,
      size: identity.size,
      mtimeMs: identity.mtimeMs,
      major: Number(identity.major) || 0,
      version: '',
      at: new Date().toISOString()
    };
    authorizedJava.set(javaKey(record.real), record);
    return record;
  } catch {
    return null;
  }
}

/** 保存设置时用：已授权的直接用；启动器枚举到的可以就地 probe 入表；其余拒绝。 */
async function assertJavaSelection(javaPath) {
  const resolved = await assertJavaExecutableShape(javaPath);
  const real = await fs.realpath(resolved);

  const found = await lookupAuthorization(real);
  if (found.state === 'ok') {
    return { real: found.record.real, major: found.record.major, version: found.record.version };
  }
  if (found.state === 'stale') {
    throw new Error(
      `这个 Java 在授权之后被修改过（文件已变化）：${real}\n` +
        '确认是你自己更新了 JDK 的话，请重新用「选择 Java…」指定一次。'
    );
  }

  if (await isEnumeratorProvidedJava(real)) {
    const { info } = await registerJava(real);
    return { real: info.path, major: info.major, version: info.version };
  }

  throw new Error(
    `这个 Java 还没有被授权：${real}\n` +
      '请在设置里用「选择 Java…」通过系统对话框指定，或把 JDK 目录加进 MCDL_JAVA / PATH。'
  );
}

/**
 * 使用点校验（启动前必过）：
 *   - 已授权且指纹一致 → 直接返回缓存信息，**不执行**；
 *   - 未授权但来自启动器自己的枚举 → probe 一次入表；
 *   - 授权过但文件变了 → 明确报"被修改过"，要求重选（不自动重跑 probe）；
 *   - 其余 → 拒绝。
 */
async function assertUsableJava(javaPath) {
  const resolved = await assertJavaExecutableShape(javaPath);
  const real = await fs.realpath(resolved);

  const found = await lookupAuthorization(real);
  if (found.state === 'ok') {
    const { record } = found;
    return {
      path: record.real,
      major: record.major,
      version: record.version,
      arch: IS_WINDOWS ? 'amd64' : process.arch,
      bitness: 64,
      vendor: ''
    };
  }
  if (found.state === 'stale') {
    throw new Error(`Java 文件在授权之后被修改过，请重新选择：${real}`);
  }

  if (await isEnumeratorProvidedJava(real)) {
    const { info } = await registerJava(real);
    return info;
  }

  throw new Error(`未授权的 Java 路径，请在设置里重新选择：${real}`);
}

/** 兼容旧调用方。 */
function assertTrustedJava(javaPath) {
  return assertUsableJava(javaPath);
}

function resetJavaAuthorizations() {
  authorizedJava.clear();
}

module.exports = {
  scanJavaRuntimes,
  getJavaRuntimes,
  bundledJava,
  findJavaForTools,
  javaMajorOf,
  pickJava,
  normalizeJavaRequirement,
  probe,
  parseProperties,
  clearCache,
  isEnumeratorProvidedJava,
  registerJava,
  restoreJavaAuthorization,
  javaAuthorization,
  assertJavaSelection,
  assertUsableJava,
  assertTrustedJava,
  resetJavaAuthorizations,
  JAVA_EXE,
  TOOLS_MIN_JAVA_MAJOR
};
