'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { writeFileAtomic } = require('./atomic-write');
// 只用来查"内置 JRE / 系统 JDK 在不在"，不执行任何进程；
// java-runtime 本身也不 require('electron')，纯 node 下可以一起加载。
const javaRuntime = require('./java-runtime');

// mcdl 是 mcdl-launcher 的内置子模块：
//   mcdl-launcher/electron/mcdl-service.js
//   mcdl-launcher/mcdl/mcdl.jar
// 不再引用项目外的 ../mcdl。
//
// 注意：这个文件**刻意不 require('electron')**（tests/smoke.test.js 守着这条）。
// 打包态的 resourcesPath / userData 由 main.js 通过 configure() 显式注入，
// 测试里也可以直接给 resolveMcdlJar({ isPackaged, resourcesPath }) 传参。
const DEV_MCDL_JAR = path.join(__dirname, '..', 'mcdl', 'mcdl.jar');

/** 主进程注入的运行时配置（默认值 = 开发态）。 */
const runtimePaths = {
  isPackaged: false,
  resourcesPath: '',
  userData: '',
  workDir: ''
};

let javaBinCache = null;
let workDirCache = '';

/**
 * 由主进程（main.js）在启动时注入打包信息。
 * 不传任何参数时保持开发态行为，纯 node 加载不受影响。
 */
function configure(options = {}) {
  if (!options || typeof options !== 'object') return;
  if (typeof options.isPackaged === 'boolean') runtimePaths.isPackaged = options.isPackaged;
  if (options.resourcesPath) runtimePaths.resourcesPath = path.resolve(String(options.resourcesPath));
  if (options.userData) runtimePaths.userData = path.resolve(String(options.userData));
  if (options.workDir) runtimePaths.workDir = path.resolve(String(options.workDir));
  // 路径变了，之前解析出来的 Java / cwd 缓存都作废。
  javaBinCache = null;
  workDirCache = '';
}

/**
 * mcdl.jar 的显式解析（不再依赖 __dirname 恰好等于 app.asar 根这种巧合）。
 *
 * 优先级：
 *   1. process.env.MCDL_JAR（保留旧行为，测试 / 高级用户可覆盖）
 *   2. 打包态：<resources>/mcdl/mcdl.jar（electron-builder extraResources）
 *   3. 开发态：electron/../mcdl/mcdl.jar
 *
 * @param {{isPackaged?:boolean, resourcesPath?:string}} [options]
 * @returns {string}
 */
function resolveMcdlJar(options = {}) {
  const fromEnv = process.env.MCDL_JAR;
  if (fromEnv) return path.resolve(fromEnv);

  const isPackaged = typeof options.isPackaged === 'boolean'
    ? options.isPackaged
    : runtimePaths.isPackaged;
  if (!isPackaged) return DEV_MCDL_JAR;

  const resourcesPath = options.resourcesPath
    ? path.resolve(String(options.resourcesPath))
    : (runtimePaths.resourcesPath || (process.resourcesPath
      ? path.resolve(String(process.resourcesPath))
      : ''));
  // 变量名是 process.resourcesPath，但开发态也可能有值（指向 Electron 自带的 resources），
  // 所以只有 isPackaged 为真时才认它；真的拿不到就退回开发态路径，让 assertMcdlJar
  // 给出"找不到 mcdl.jar"的可读错误，而不是一个空路径。
  return resourcesPath ? path.join(resourcesPath, 'mcdl', 'mcdl.jar') : DEV_MCDL_JAR;
}

/** jar 不存在时给可读错误（而不是让 spawn 报一个莫名的失败）。 */
async function assertMcdlJar(jarPath) {
  const jar = path.resolve(String(jarPath || resolveMcdlJar()));
  try {
    const stat = await fs.stat(jar);
    if (stat.isFile()) return jar;
  } catch {
    // 落到下面统一报错
  }

  const error = new Error(
    `找不到 mcdl.jar：${jar}\n` +
      '安装包可能不完整（缺少 resources/mcdl/mcdl.jar），请重新安装或重新打包 MCDL Launcher。'
  );
  error.code = 'ENOJAR';
  error.path = jar;
  throw error;
}

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
let versionCacheSource = '';
let versionMeta = { latestRelease: '', latestSnapshot: '' };

const SOURCE_KEYS = new Set(['auto', 'official', 'bmclapi']);

/** 设置里的下载源 → mcdl 的 --source 参数（官方 / BMCLAPI / 自动测速）。 */
function normalizeSource(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'mojang' || key === 'offical') return 'official';
  if (key === 'bmcl' || key === 'mirror') return 'bmclapi';
  return SOURCE_KEYS.has(key) ? key : 'auto';
}

/** 「完全没有 Java」的统一错误：渲染层能拿到 code，也有一句能照着做的中文提示。 */
function javaMissingError() {
  const error = new Error(
    '本机没有可用的 Java 17 及以上版本（mcdl.jar 由 JDK 17 编译）：'
    + '可以点「设置 → Java 管理 → 安装 Java」下载，或手动选择一个 JDK 17+。'
  );
  error.code = 'ENOJAVA';
  return error;
}

/**
 * 解析 mcdl 子进程要用的 java。
 *
 * 优先级（与 java-runtime.findJavaForTools 保持一致）：
 *   MCDL_JAVA → 内置 JRE → 已登记 / 扫描到的 JDK → JAVA_HOME → 系统 PATH
 *
 * 找不到时抛 code = 'ENOJAVA' 的可读错误，绝不让 spawn 的 ENOENT 冒到渲染层。
 *
 * @param {{force?:boolean, resourcesPath?:string, candidates?:string[]}} [options]
 */
async function resolveJavaBinary(options = {}) {
  if (!options.force && javaBinCache) return javaBinCache;

  const found = await javaRuntime.findJavaForTools({
    resourcesPath: options.resourcesPath !== undefined
      ? options.resourcesPath
      : runtimePaths.resourcesPath,
    candidates: options.candidates
  });
  if (!found) throw javaMissingError();

  javaBinCache = found;
  return found;
}

/** 目录可写探针：真实写一个临时文件再删掉，比 fs.access(W_OK) 在 Windows 上可靠。 */
async function isWritableDir(dir) {
  const probe = path.join(dir, `.mcdl-write-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, '1');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    await fs.rm(probe, { force: true }).catch(() => {});
    return false;
  }
}

/**
 * mcdl 的 cwd。必须是可写目录：装在 C:\Program Files 时 resources\mcdl 只读，
 * mcdl 一旦往 cwd 写东西就是 EACCES。
 *
 * 候选顺序：显式配置 → <userData>/mcdl → jar 所在目录（开发态）→ 系统临时目录。
 * 逐项做写探针，第一个可写的胜出；全都失败时退回 os.tmpdir()，
 * 让 spawn 至少还有机会报一个具体错误。
 */
async function resolveWorkDir(jarPath, options = {}) {
  if (workDirCache && (await isWritableDir(workDirCache))) return workDirCache;

  const candidates = [];
  if (options.cwd) candidates.push(path.resolve(String(options.cwd)));
  if (runtimePaths.workDir) candidates.push(runtimePaths.workDir);
  if (runtimePaths.userData) candidates.push(path.join(runtimePaths.userData, 'mcdl'));
  // 开发态：jar 就在可写的项目目录里；打包态这一项通常只读，会被探针跳过后落到临时目录。
  candidates.push(path.dirname(jarPath));
  candidates.push(path.join(os.tmpdir(), 'mcdl-launcher-mcdl'));

  for (const candidate of dedupeWorkDirs(candidates)) {
    if (await isWritableDir(candidate)) {
      workDirCache = candidate;
      return candidate;
    }
  }

  workDirCache = os.tmpdir();
  return workDirCache;
}

function dedupeWorkDirs(dirs) {
  const seen = new Set();
  const result = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const resolved = path.resolve(dir);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

// ---------------- 子进程输出编码 ----------------

// JDK 18 起，-Dfile.encoding 不再决定重定向到管道/文件时的 System.out 编码：
// 它改由 -Dstdout.encoding 控制，默认取「本地编码」（中文 Windows = GBK/CP936）。
// 本机实测（JDK 25 + Node spawn 管道）：只给 -Dfile.encoding=UTF-8 时 stdout 是 GBK；
// 补上 -Dstdout.encoding=UTF-8 立刻变成 UTF-8。JDK 17 只认 file.encoding，
// 两条参数一起给，17 和 18+ 都能拿到 UTF-8。
const MCDL_JVM_OPTS = [
  '-Dfile.encoding=UTF-8',
  '-Dstdout.encoding=UTF-8',
  '-Dstderr.encoding=UTF-8'
];

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
let gb18030Decoder = null;
let gb18030Probed = false;

/** gb18030 解码器是否可用（Node / Electron 带 full ICU 时可用，纯 UTF-8 构建时没有）。 */
function gb18030Available() {
  if (gb18030Probed) return Boolean(gb18030Decoder);
  gb18030Probed = true;
  try {
    gb18030Decoder = new TextDecoder('gb18030');
  } catch {
    gb18030Decoder = null;
  }
  return Boolean(gb18030Decoder);
}

/**
 * 是不是 UTF-8。允许末尾缺 1~3 个字节：流式解码时一个多字节字符可能被切在
 * 两个 chunk 中间，不能因为这点就把编码判成 GBK。
 */
function looksLikeUtf8(buf) {
  if (!buf.length) return true;
  const probe = buf.subarray(0, Math.min(buf.length, 64 * 1024));
  for (let cut = 0; cut <= 3 && probe.length - cut > 0; cut += 1) {
    try {
      STRICT_UTF8.decode(probe.subarray(0, probe.length - cut));
      return true;
    } catch {
      // 换更短的尾巴再试
    }
  }
  return false;
}

/**
 * 探测 mcdl 输出用的编码。
 *
 * 首选（正常情况下）是 JVM 参数保证的 UTF-8；这里兜底的是历史/异常情况：
 *   - UTF-16LE（无 BOM，ASCII 字符低字节在高位位置全是 0x00）
 *   - 带 BOM 的 UTF-8 / UTF-16LE / UTF-16BE
 *   - 中文 Windows 的 GBK（MCDL 输出全是中文表头，GBK 不是合法 UTF-8）
 *
 * @param {Buffer} buf
 * @returns {'utf-8'|'utf-16le'|'utf-16be'|'gb18030'|'latin1'}
 */
function sniffMcdlEncoding(buf) {
  if (!buf || buf.length === 0) return 'utf-8';
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';

  // 无 BOM 的 UTF-16：文本里出现 0x00 只可能来自 UTF-16（UTF-8 / GBK 的正文
  // 都不会有 NUL）。ASCII 字符（版本号、日期、表格空格）的高字节是 0，
  // 看 0 落在偶数位还是奇数位就能分出 LE / BE。
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (sample.includes(0)) {
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i < sample.length; i += 1) {
      if (sample[i] !== 0) continue;
      if (i % 2 === 0) evenZero += 1;
      else oddZero += 1;
    }
    if (oddZero > evenZero * 2) return 'utf-16le';
    if (evenZero > oddZero * 2) return 'utf-16be';
    return oddZero >= evenZero ? 'utf-16le' : 'utf-16be';
  }

  if (looksLikeUtf8(buf)) return 'utf-8';
  return gb18030Available() ? 'gb18030' : 'latin1';
}

/** 按探测出来的编码造一个流式解码器（TextDecoder，chunk 边界由 stream:true 处理）。 */
function createDecoder(encoding) {
  if (encoding === 'latin1') {
    return { decode: (buf) => (buf && buf.length ? buf.toString('latin1') : '') };
  }

  if (encoding === 'utf-16be') {
    // Node 的 TextDecoder 支持 utf-16be，但不保证每个 Electron/ICU 构建都有；
    // 手动按字节交换更稳，还能顺手处理奇数长度 chunk 的半个字符。
    const le = new TextDecoder('utf-16le');
    let carry = null;
    return {
      decode(buf, options) {
        if (!buf || buf.length === 0) {
          const rest = carry ? carry.toString('utf16le') : '';
          carry = null;
          return rest;
        }
        let chunk = buf;
        if (carry) {
          chunk = Buffer.concat([carry, buf]);
          carry = null;
        }
        if (chunk.length % 2 === 1) {
          carry = Buffer.from(chunk.subarray(chunk.length - 1));
          chunk = chunk.subarray(0, chunk.length - 1);
        }
        if (!chunk.length) return '';
        const swapped = Buffer.from(chunk);
        swapped.swap16();
        return le.decode(swapped, options);
      }
    };
  }

  return new TextDecoder(encoding);
}

/**
 * 把一段 mcdl 输出按实际编码解成字符串。
 * @param {Buffer|string} input
 * @returns {{text:string, encoding:string}}
 */
function decodeMcdlOutput(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  const encoding = sniffMcdlEncoding(buf);
  return { text: createDecoder(encoding).decode(buf), encoding };
}

/**
 * 流式解码器：编码要在看到首批字节后才能确定，所以先攒一小段再决定；
 * 拿到结尾时如果整段缓冲的判定和流式判定不一致，用整段重解（runMcdl 里这么用）。
 */
function createOutputDecoder() {
  let encoding = '';
  let decoder = null;
  let pending = [];
  let pendingLength = 0;

  const start = (probe) => {
    encoding = sniffMcdlEncoding(probe);
    decoder = createDecoder(encoding);
  };

  return {
    get encoding() {
      return encoding;
    },
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!decoder) {
        pending.push(buf);
        pendingLength += buf.length;
        // 有换行就说明开头这些字节是完整的（0x0A 不会出现在多字节字符中间）；
        // 没有换行就一直攒到 4KB，避免把一个 UTF-8 字符切在中间误判成 GBK。
        if (pendingLength < 4096 && !buf.includes(0x0a) && !buf.includes(0x0d)) return '';
        const head = Buffer.concat(pending);
        pending = [];
        pendingLength = 0;
        start(head);
        return decoder.decode(head, { stream: true });
      }
      return decoder.decode(buf, { stream: true });
    },
    end() {
      if (!decoder) {
        const head = Buffer.concat(pending);
        pending = [];
        pendingLength = 0;
        start(head);
        return decoder.decode(head);
      }
      return decoder.decode();
    }
  };
}

async function runMcdl(args, options = {}) {
  const jar = await assertMcdlJar(options.jar || resolveMcdlJar(options));
  const javaBin = await resolveJavaBinary(options);
  const workDir = await resolveWorkDir(jar, options);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutEncoding = 'utf-8';
    let stderrEncoding = 'utf-8';
    let finished = false;

    const stdoutChunks = [];
    const stderrChunks = [];

    const env = { ...process.env };
    // Avoid polluted JVM options and the "Picked up ..." stderr noise.
    delete env.JAVA_TOOL_OPTIONS;
    delete env.JDK_JAVA_OPTIONS;
    delete env._JAVA_OPTIONS;
    delete env.JAVA_OPTIONS;

    const child = spawn(javaBin, [...MCDL_JVM_OPTS, '-jar', jar, ...args], {
      cwd: workDir,
      windowsHide: true,
      env
    });

    // 取消：kill 掉 mcdl 的 JVM。已经写下的文件保留，下次安装会接着用。
    let aborted = false;
    const onAbort = () => {
      if (finished) return;
      aborted = true;
      try {
        child.kill();
      } catch {
        // 进程可能已经退出
      }
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // 进度回调走流式解码（边收边给），最终解析用整段缓冲重解一次：
    // 编码在 4KB 时可能还判不准，整段缓冲才是唯一可靠依据。
    const stdoutDecoder = createOutputDecoder();
    const stderrDecoder = createOutputDecoder();

    const emit = (text, stream) => {
      if (!text) return;
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (typeof options.onData === 'function') {
        options.onData(text, stream);
      }
    };

    const decodeAll = () => {
      const out = decodeMcdlOutput(Buffer.concat(stdoutChunks));
      const err = decodeMcdlOutput(Buffer.concat(stderrChunks));
      stdout = out.text;
      stderr = err.text;
      stdoutEncoding = out.encoding;
      stderrEncoding = err.encoding;
    };

    child.stdout.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutChunks.push(buf);
      emit(stdoutDecoder.push(buf), 'stdout');
    });
    child.stderr.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrChunks.push(buf);
      emit(stderrDecoder.push(buf), 'stderr');
    });

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      decodeAll();

      // ENOENT 说明 resolveJavaBinary 找到的路径在执行前被移走了（或被安全软件拦掉）。
      // 仍然转成明确文案，不让裸 ENOENT 冒到渲染层。
      if (error && error.code === 'ENOENT') {
        const missing = new Error(
          `找不到可用的 Java 可执行文件：${javaBin}\n` +
            '可以点「设置 → Java 管理 → 安装 Java」下载，或手动选择 JDK。'
        );
        missing.code = 'ENOJAVA';
        missing.stdout = stdout;
        missing.stderr = stderr;
        reject(missing);
        return;
      }

      reject(new Error(`无法启动 Java/mcdl: ${error.message}`));
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      decodeAll();

      if (aborted) {
        const cancelled = new Error('已取消');
        cancelled.cancelled = true;
        cancelled.code = 'TASK_CANCELLED';
        cancelled.stdout = stdout;
        cancelled.stderr = stderr;
        reject(cancelled);
        return;
      }

      if (code === 0) {
        // 把实际编码带出去：版本列表解析不到时，错误信息里要能看出
        // 「到底是没数据，还是编码不对」。
        resolve({ stdout, stderr, stdoutEncoding, stderrEncoding });
      } else {
        const detail = (stderr || stdout).trim().split(/\r?\n/).slice(-8).join('\n');
        const error = new Error(`mcdl 执行失败（退出码 ${code}）${detail ? `\n${detail}` : ''}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.stdoutEncoding = stdoutEncoding;
        error.stderrEncoding = stderrEncoding;
        error.exitCode = code;
        error.javaBin = javaBin;
        error.jar = jar;
        // 把实际用的 java 打进日志：mcdl.jar 需要 Java 17+，如果挑到 Java 8，
        // 栈里只会是 checkAndLoadMain 的 ClassNotFound，看不出根因。
        console.error(
          `[mcdl] 调用失败：java=${javaBin} exit=${code} `
          + `stdout=${stdoutEncoding} stderr=${stderrEncoding}`
        );
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
    await writeFileAtomic(marker, JSON.stringify(markerData, null, 2), { encoding: 'utf8' }).catch(() => {});
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

function detectLoader(meta, hint) {
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

  // 加载器实例有时只写一层 inheritsFrom（例如 forge 安装器生成的 1.20.1-forge-47.4.28），
  // 自身没有 libraries，只能从父版本 id 或目录名反推。
  return loaderFromText(meta.inheritsFrom) || loaderFromText(hint) || 'Vanilla';
}

function loaderFromText(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return '';
  if (/quilt/.test(text)) return 'Quilt';
  if (/fabric/.test(text)) return 'Fabric';
  if (/neoforge/.test(text)) return 'NeoForge';
  if (/forge/.test(text)) return 'Forge';
  return '';
}

/** 从 inheritsFrom / 版本 id 里抽加载器版本号，例如 1.20.1-forge-47.4.28 → 47.4.28。 */
function loaderVersionFromText(value) {
  const text = String(value || '');
  const forge = text.match(/-forge[-\s]?([\w.+-]+)$/i);
  if (forge) return forge[1];
  const neo = text.match(/neoforge[-\s]?([\w.+-]+)$/i);
  if (neo) return neo[1];
  return '';
}

/** 加载器 json 的 libraries 里就写着加载器版本，Fabric / Quilt 只能从这里读。 */
function loaderVersionFromLibraries(meta) {
  const libraries = Array.isArray(meta && meta.libraries) ? meta.libraries : [];
  const patterns = [
    /^net\.fabricmc:fabric-loader:([^:@]+)/,
    /^org\.quiltmc:quilt-loader:([^:@]+)/,
    /^net\.neoforged:neoforge:([^:@]+)/,
    /^net\.minecraftforge:forge:([^:@]+)/
  ];
  for (const library of libraries) {
    const name = String(library && library.name || '');
    for (const pattern of patterns) {
      const match = name.match(pattern);
      if (match) return match[1];
    }
  }
  return '';
}

const MC_VERSION_PATTERN = /(?:^|[^\d])(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)(?:[^\d]|$)/;

function versionFromText(value) {
  const match = String(value || '').match(MC_VERSION_PATTERN);
  return match ? match[1] : '';
}

function detectGameVersion(meta, folderName) {
  for (const candidate of [meta.inheritsFrom, meta.id, folderName]) {
    const hit = versionFromText(candidate);
    if (hit) return hit;
  }
  return typeof meta.id === 'string' ? meta.id : (folderName || '');
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
    const loader = detectLoader(manifest, entry.name);
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
      modLoaderVersion: loader === 'Vanilla'
        ? ''
        : (loaderVersionFromLibraries(manifest)
          || loaderVersionFromText(manifest.inheritsFrom)
          || loaderVersionFromText(entry.name)),
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
 *
 * 内置 JRE 放在最前面：它一定存在（打包时随 extraResources 分发），
 * 也是「本机没装 Java」时唯一能选到的运行时。
 */
async function listJavaPaths() {
  const result = await runMcdl(['--list-java']);
  const paths = [];
  const seen = new Set();

  const bundled = javaRuntime.bundledJava({ resourcesPath: runtimePaths.resourcesPath });
  if (bundled) {
    seen.add(bundled.toLowerCase());
    paths.push(bundled);
  }

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

/**
 * 解析 mcdl `--list` 的文本表格（纯函数，测试直接喂字符串）。
 *
 * 输出形如：
 *   最新正式版：1.21.8    最新快照：25w31a
 *   1.21.8             正式版     2025-07-17
 *   25w31a             快照       2025-07-29
 *   1.14.2 Pre-Release 4  快照    2019-05-13
 *
 * @param {string} output
 * @returns {{versions:Array<{id:string,date:string,type:string,typeLabel:string}>, latestRelease:string, latestSnapshot:string}}
 */
function parseVersionTable(output) {
  const text = String(output || '');
  const versions = [];

  // mcdl 的列表头写着「最新正式版：1.21.8    最新快照：25w31a」，
  // 下载页的「最新」两张卡直接用这两行，不再自己按日期猜。
  const latest = text.match(/最新正式版[：:]\s*([^\s]+)\s+最新快照[：:]\s*([^\s]+)/);
  const latestRelease = latest ? latest[1] : '';
  const latestSnapshot = latest ? latest[2] : '';

  for (const line of text.split(/\r?\n/)) {
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

  return { versions, latestRelease, latestSnapshot };
}

async function listVersions({ source = 'auto' } = {}) {
  const now = Date.now();
  const sourceKey = normalizeSource(source);
  if (versionCache && versionCacheSource === sourceKey && now - versionCacheAt < 10 * 60 * 1000) {
    return versionCache;
  }

  const result = await runMcdl(['--list', '--type', 'all', '--source', sourceKey]);
  const { versions, latestRelease, latestSnapshot } = parseVersionTable(result.stdout);

  if (latestRelease && latestSnapshot) {
    versionMeta = { latestRelease, latestSnapshot };
  }

  if (versions.length === 0) {
    // 上一版这里只有「没有返回可解析的版本列表」一句，看不出是网络没数据、
    // 还是 stdout 编码不对（UTF-16LE / GBK 都曾让正则 0 命中）。
    const lines = String(result.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const head = lines.slice(0, 5).map((line) => line.slice(0, 160)).join('\n');
    const error = new Error(
      'mcdl 没有返回可解析的版本列表'
        + `（stdout 编码 ${result.stdoutEncoding || '未知'}，共 ${lines.length} 行）`
        + (head ? `\n${head}` : '')
    );
    error.code = 'EMCDLLIST';
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.stdoutEncoding = result.stdoutEncoding;
    console.error(`[mcdl] 版本列表解析失败：stdout=${result.stdoutEncoding} 行数=${lines.length}`);
    throw error;
  }

  versionCache = versions;
  versionCacheAt = now;
  versionCacheSource = sourceKey;
  return versions;
}

async function installVersion({ version, gameDir, source = 'auto', jobs = 16, assets = true, assetsOnly = false, verify = false, onData, signal }) {
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
    '--source', normalizeSource(source),
    '--jobs', String(Math.max(1, Math.min(64, Number(jobs) || 16)))
  ];
  if (assets === false) args.push('--no-assets');
  // 「更新游戏资源文件」走 --assets-only（只对比并补齐 assets，不动 jar / 库）；
  // --verify 让 mcdl 对已存在的资源做 SHA-1 校验，修掉损坏的文件。
  if (assetsOnly) args.push('--assets-only');
  if (verify) args.push('--verify');

  await runMcdl(args, {
    signal,
    onData: (text, stream) => {
      if (typeof onData === 'function') onData(text, stream);
    }
  });

  return dir;
}

/**
 * 版本目录：版本列表 + mcdl 给出的最新正式版 / 最新快照。
 * force 用于下载页的「刷新」（mcdl-service 里缓存 10 分钟）。
 */
async function versionCatalog({ force = false, source = 'auto' } = {}) {
  if (force) {
    versionCache = null;
    versionCacheAt = 0;
    versionCacheSource = '';
  }
  const versions = await listVersions({ source });
  return {
    versions,
    latestRelease: versionMeta.latestRelease || (versions[0] && versions[0].id) || '',
    latestSnapshot: versionMeta.latestSnapshot || '',
    fetchedAt: versionCacheAt,
    cached: !force
  };
}

// ---------------- 整合包：本地 zip / mrpack ----------------

/**
 * 读取 zip 的中央目录，不依赖任何 zip 库（整合包动辄几百 MB，只读目录区）。
 * @returns {Promise<Array<{name:string,size:number}>>}
 */
async function readZipEntries(file, limit = 800) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;
    if (size < 22) return [];

    const tailLen = Math.min(size, 66 * 1024);
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return [];

    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (!cdSize || cdOffset >= size) return [];

    const cdLen = Math.min(cdSize, 8 * 1024 * 1024);
    const cd = Buffer.alloc(cdLen);
    await handle.read(cd, 0, cdLen, cdOffset);

    const entries = [];
    let p = 0;
    for (let i = 0; i < total && p + 46 <= cd.length; i += 1) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const compressed = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
      entries.push({ name, size: compressed });
      p += 46 + nameLen + extraLen + commentLen;
      if (entries.length >= limit) break;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * 整合包预览：文件名、大小、条目数、主要文件（manifest / mods / overrides）。
 */
async function inspectModpack(file) {
  const pack = path.resolve(String(file || ''));
  const stat = await fs.stat(pack).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('找不到整合包文件');
  const ext = path.extname(pack).toLowerCase();
  if (ext !== '.zip' && ext !== '.mrpack') throw new Error('只支持 .zip / .mrpack 整合包');

  const entries = await readZipEntries(pack);
  // Windows 打出来的 zip 里分隔符可能是反斜杠，两个都认。
  const manifest = entries.find((entry) => /(^|[\\/])(modrinth|manifest|instance)\.(index\.)?json$/i.test(entry.name));
  const mods = entries.filter((entry) => /(^|[\\/])(mods|overrides[\\/]mods)[\\/]/i.test(entry.name));
  const overrides = entries.filter((entry) => /(^|[\\/])overrides[\\/]/i.test(entry.name));

  return {
    path: pack,
    file: path.basename(pack),
    size: stat.size,
    entryCount: entries.length,
    manifest: manifest ? manifest.name : '',
    sample: entries.slice(0, 60).map((entry) => entry.name),
    modCount: mods.length,
    overrideCount: overrides.length
  };
}

/**
 * 安装整合包：mcdl --install-pack 解压到 <gameDir>/versions/<实例名>。
 * @returns {{instanceId:string,instanceDir:string,gameDir:string}}
 */
async function installModpack({ file, name = '', gameDir, jobs = 16, cfKey = '', onData, signal }) {
  const pack = path.resolve(String(file || ''));
  const stat = await fs.stat(pack).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('找不到整合包文件');
  const ext = path.extname(pack).toLowerCase();
  if (ext !== '.zip' && ext !== '.mrpack') throw new Error('只支持 .zip / .mrpack 整合包');

  const dir = gameDir || await detectGameDir();
  await fs.mkdir(dir, { recursive: true });

  const args = [
    '--install-pack', pack,
    '--dir', dir,
    '--jobs', String(Math.max(1, Math.min(64, Number(jobs) || 16)))
  ];
  if (name) args.push('--name', String(name));
  if (cfKey) args.push('--cf-key', String(cfKey));

  const result = await runMcdl(args, {
    signal,
    onData: (text, stream) => {
      if (typeof onData === 'function') onData(text, stream);
    }
  });

  const done = String(result.stdout).match(/\[完成\]\s*实例\s+(.+?)\s*→\s*(.+)\s*$/m);
  const instanceId = done ? done[1].trim() : (name || path.basename(pack, ext));
  const instanceDir = done ? done[2].trim() : path.join(dir, 'versions', instanceId);

  return { instanceId, instanceDir, gameDir: dir };
}

function clearCaches() {
  gameDirCache = null;
  versionCache = null;
  versionCacheAt = 0;
  versionCacheSource = '';
  versionMeta = { latestRelease: '', latestSnapshot: '' };
}

// ---------------- 模组加载器：列表 / 自动安装 ----------------

/** 界面上的加载器名 → mcdl 的后端键。 */
const LOADER_KEYS = {
  fabric: 'fabric-loader',
  'fabric-loader': 'fabric-loader',
  quilt: 'quilt-loader',
  'quilt-loader': 'quilt-loader',
  forge: 'forge',
  neoforge: 'neoforge'
};

function loaderKeyOf(value) {
  return LOADER_KEYS[String(value || '').trim().toLowerCase()] || '';
}

/** 界面传进来的加载器名（Fabric / Forge …）是否支持自动安装。 */
function isSupportedLoader(value) {
  return Boolean(loaderKeyOf(value));
}

/** 从 mcdl 的 stdout 里取最后一段 JSON（安装结果）。 */
function parseTrailingJson(stdout) {
  const text = String(stdout || '');
  const start = text.lastIndexOf('\n{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

/**
 * 列出某个 Minecraft 版本可用的加载器构建。
 * @returns {{loader:string,label:string,gameVersion:string,versions:Array<{version:string,stable:boolean,note:string}>}}
 */
async function listLoaders({ loader, mcVersion, source = 'auto' } = {}) {
  const key = loaderKeyOf(loader);
  if (!key) throw new Error(`不支持的加载器：${loader}`);
  if (!mcVersion) throw new Error('缺少 Minecraft 版本');

  const result = await runMcdl([
    '--list-loaders', key,
    '--mc', String(mcVersion),
    '--source', normalizeSource(source)
  ]);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('mcdl 返回的加载器列表不是合法 JSON');
  }
  if (!parsed || !Array.isArray(parsed.versions)) {
    throw new Error('mcdl 返回的加载器列表为空');
  }
  return parsed;
}

/**
 * 自动安装加载器：mcdl 会先确保原版，再生成一个独立实例。
 * @returns {{instanceId:string,instanceDir:string,loader:string,label:string,loaderVersion:string,gameVersion:string}}
 */
async function installLoader({
  loader,
  loaderVersion = '',
  mcVersion,
  name = '',
  gameDir,
  jobs = 16,
  source = 'auto',
  onData,
  signal
} = {}) {
  const key = loaderKeyOf(loader);
  if (!key) throw new Error(`不支持的加载器：${loader}`);
  if (!mcVersion) throw new Error('缺少 Minecraft 版本');
  if (loaderVersion && !/^[A-Za-z0-9][A-Za-z0-9 ._()+\-]{0,127}$/.test(String(loaderVersion))) {
    throw new Error('无效的加载器版本号');
  }

  const dir = gameDir || await detectGameDir();
  await fs.mkdir(dir, { recursive: true });

  const args = [
    '--install-loader', key,
    '--mc', String(mcVersion),
    '--dir', dir,
    '--jobs', String(Math.max(1, Math.min(64, Number(jobs) || 16))),
    '--source', normalizeSource(source)
  ];
  if (loaderVersion) args.push('--loader-version', String(loaderVersion));
  if (name) args.push('--name', String(name));

  const result = await runMcdl(args, {
    signal,
    onData: (text, stream) => {
      if (typeof onData === 'function') onData(text, stream);
    }
  });

  const parsed = parseTrailingJson(result.stdout);
  if (!parsed || !parsed.instanceId) {
    throw new Error('mcdl 没有返回安装结果');
  }
  return { ...parsed, gameDir: dir };
}

module.exports = {
  configure,
  resolveMcdlJar,
  assertMcdlJar,
  resolveJavaBinary,
  javaMissingError,
  resolveWorkDir,
  DEFAULT_GAME_DIR,
  LAUNCHER_HOME,
  ensureGameDir,
  detectGameDir,
  findOtherGameDirs,
  scanInstances,
  listVersions,
  versionCatalog,
  installVersion,
  listLoaders,
  installLoader,
  isSupportedLoader,
  loaderKeyOf,
  inspectModpack,
  installModpack,
  listJavaPaths,
  parseGameDirs,
  normalizeSource,
  clearCaches,
  // 编码层：给测试和排查用（子进程输出到底被当成什么编码解出来的）。
  decodeMcdlOutput,
  sniffMcdlEncoding,
  createOutputDecoder,
  parseVersionTable,
  MCDL_JVM_OPTS
};

// 兼容旧调用方（main.js 的启动日志 / 脚本）：MCDL_JAR 现在是"按当前配置解析一次"的只读视图。
Object.defineProperty(module.exports, 'MCDL_JAR', {
  enumerable: true,
  get: () => resolveMcdlJar()
});
