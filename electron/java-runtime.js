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
const path = require('node:path');

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

/** 环境变量 + PATH 上的 java。 */
async function environmentCandidates() {
  const result = [];

  if (process.env.MCDL_JAVA) {
    const configured = path.resolve(process.env.MCDL_JAVA);
    // 允许直接给 java.exe，也允许给 JDK 根目录。
    result.push(
      ...(/\.exe$/i.test(configured) || path.basename(configured) === JAVA_EXE
        ? [configured]
        : javaCandidatesInHome(configured))
    );
  }

  if (process.env.JAVA_HOME) {
    result.push(...javaCandidatesInHome(process.env.JAVA_HOME));
  }

  const pathDirs = String(process.env.PATH || '').split(IS_WINDOWS ? ';' : ':');
  for (const dir of pathDirs) {
    if (!dir) continue;
    const trimmed = dir.replace(/^"|"$/g, '').trim();
    if (!trimmed) continue;
    // PATH 里通常就是 <jdk>\bin。
    result.push(path.join(trimmed, JAVA_EXE));
  }

  return result;
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
 * 扫描本机所有可用的 Java。
 * @returns {Promise<Array<{path:string,major:number,version:string,arch:string,bitness:number,vendor:string}>>}
 */
async function scanJavaRuntimes(mcdlService) {
  const candidates = dedupe([
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
    runtimes.push(info);
  }

  runtimes.sort((a, b) => a.major - b.major || a.path.localeCompare(b.path));
  return runtimes;
}

async function getJavaRuntimes(mcdlService, options = {}) {
  if (cache && !options.force) return cache;
  cache = await scanJavaRuntimes(mcdlService);
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

/**
 * 按版本 JSON 的 javaVersion.majorVersion 选一个 Java。
 *
 * 规则：
 *   - 64 位优先，其次版本号更高；
 *   - 优先主版本号完全相同的；
 *   - 否则取“主版本号 >= 要求”里最小的（旧版本对高版本 JVM 常常不兼容）；
 *   - 要求高于所有可用版本时，退回最高可用版本（报错信息由启动阶段给出）。
 */
function pickJava(runtimes, requiredMajor) {
  if (!Array.isArray(runtimes) || runtimes.length === 0) return null;
  const required = Number(requiredMajor) || 0;

  const sorted = runtimes.slice().sort((a, b) => (
    (b.bitness || 0) - (a.bitness || 0) ||
    compareVersion(b.version, a.version) ||
    a.path.localeCompare(b.path)
  ));

  if (!required) return sorted[0];

  const exact = sorted.filter((item) => item.major === required);
  if (exact.length > 0) return exact[0];

  const atLeast = sorted.filter((item) => item.major >= required);
  if (atLeast.length > 0) {
    // 已经是 64 位优先 + 高版本优先，取主版本最小的那批里的第一个。
    const minMajor = Math.min(...atLeast.map((item) => item.major));
    return atLeast.find((item) => item.major === minMajor) || atLeast[0];
  }

  return sorted[0];
}

function clearCache() {
  cache = null;
}

module.exports = {
  scanJavaRuntimes,
  getJavaRuntimes,
  pickJava,
  probe,
  parseProperties,
  clearCache,
  JAVA_EXE
};
