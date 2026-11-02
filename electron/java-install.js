'use strict';

/**
 * 「设置 → Java 管理 → 安装 Java」的实现。
 *
 * 只做一件最小但完整的事：从 Eclipse Adoptium（Temurin）下载一个指定主版本的
 * Windows JDK、校验、解压到 <userData>/java/、返回 java.exe 路径，由主进程登记授权。
 *
 * 为什么是 Adoptium：公开 API、无需 key、assets 接口同时给出下载直链、
 * SHA-256 校验值与字节数，失败可以直接报错而不是留下半个 JDK。
 *
 * 完整性校验是必须的：下载落盘后先比对 size / SHA-256，通过才允许解压。
 * 拿不到 SHA-256（assets 接口不可用，或包本身没带 checksum）时**中止安装**、
 * 不再下载解压：JDK 解压后是要直接执行的 java.exe，不能接受未校验的二进制。
 *
 * 明确不做：
 *   - 不安装到 C:\Program Files（需要管理员权限）；
 *   - 不修改系统 PATH / JAVA_HOME；
 *   - 不静默替换用户已选的 Java。
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

const ADOPTIUM_BIN = 'https://api.adoptium.net/v3/binary/latest';
const ADOPTIUM_ASSETS = 'https://api.adoptium.net/v3/assets/latest';
const SUPPORTED_MAJORS = [8, 11, 17, 21, 25];
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function adoptiumArch() {
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'ia32') return 'x86';
  return 'x64';
}

function adoptiumUrl(major) {
  const feature = Number(major) || 21;
  return `${ADOPTIUM_BIN}/${feature}/windows/${adoptiumArch()}/jdk/hotspot/normal/eclipse?project=jdk`;
}

/** assets 接口：同时给出 package.link / checksum / size。 */
function adoptiumAssetsUrl(major) {
  const feature = Number(major) || 21;
  return (
    `${ADOPTIUM_ASSETS}/${feature}/hotspot` +
    `?os=windows&architecture=${adoptiumArch()}&image_type=jdk`
  );
}

function stamp() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function formatMb(bytes) {
  return (Number(bytes || 0) / (1024 * 1024)).toFixed(1) + ' MB';
}

// ---------------- 校验相关的纯逻辑（可单测） ----------------

/**
 * 规范化一个 SHA-256 十六进制串：去空白、转小写、必须是 64 位 hex。
 * 拿不到合法值时返回空串，调用方必须据此拒绝（不再有「未校验」路径）。
 */
function normalizeSha256(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  return SHA256_HEX.test(raw) ? raw : '';
}

/** 大小写不敏感地比较两个 SHA-256；任一为空或非法一律返回 false。 */
function sha256Matches(expected, actual) {
  const a = normalizeSha256(expected);
  const b = normalizeSha256(actual);
  if (!a || !b) return false;
  return a === b;
}

/**
 * 从 assets/latest 的响应里取出第一个可用包。
 * 正常返回 { link, checksum, size }；结构不对 / 数组为空 / 没有 package
 * 时返回 null。
 *
 * 这里只做纯解析：缺 checksum 时 checksum 为空串，但**调用方必须拒绝**
 * （见 resolveDownloadSource / verifyDownload），不允许拿空 checksum 继续下载。
 *
 * @param {unknown} payload
 * @returns {{link:string, checksum:string, size:number}|null}
 */
function pickAdoptiumAsset(payload) {
  if (!Array.isArray(payload) || payload.length === 0) return null;

  const first = payload[0];
  const pkg = first && first.binary && first.binary.package;
  if (!pkg || typeof pkg !== 'object') return null;

  const link = typeof pkg.link === 'string' ? pkg.link.trim() : '';
  if (!link) return null;

  const size = Number(pkg.size);
  return {
    link,
    checksum: normalizeSha256(pkg.checksum),
    size: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0
  };
}

function checksumMismatchMessage(expected, actual) {
  return (
    `JDK 下载校验失败：期望 SHA-256 ${expected}，实际 ${actual}。` +
    '可能是网络被劫持或 CDN 返回了错误内容，请重试或改用「选择 Java…」手动指定。'
  );
}

function sizeMismatchMessage(expected, actual) {
  return (
    `JDK 下载校验失败：期望大小 ${expected} 字节（${formatMb(expected)}），` +
    `实际 ${actual} 字节（${formatMb(actual)}）。` +
    '下载可能被截断或 CDN 返回了错误内容，请重试或改用「选择 Java…」手动指定。'
  );
}

/**
 * 「拿不到期望的 SHA-256」时的统一拒绝文案。
 *
 * 这是安全加固的核心：Adoptium 的 assets 接口正常都带 package.checksum，
 * 拿不到就说明接口降级或响应结构变了；此时既不能盲信直链下载，也不能
 * 只比大小，只能中止，并告诉用户下一步能做什么。
 *
 * @param {string} [detail] 技术原因（HTTP 状态 / 结构问题），拼进括号里
 */
function missingChecksumMessage(detail = '') {
  const reason = String(detail || '').trim();
  return (
    'Adoptium 未提供该 JDK 的校验值，为避免下载到被篡改的包，已中止安装。' +
    (reason ? `（${reason}）` : '') +
    '请稍后重试或改用系统里已有的 JDK。'
  );
}

/** 流式算文件 SHA-256（不把整个 zip 读进内存）。 */
async function computeSha256(file) {
  const hash = createHash('sha256');
  const stream = fsSync.createReadStream(file);
  try {
    for await (const chunk of stream) hash.update(chunk);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return hash.digest('hex');
}

/**
 * 校验落盘的安装包。必须在解压之前调用。
 *
 * - SHA-256 是必填：缺失即拒绝（删文件后抛错），不存在「只比大小」的降级；
 * - 有 size：先比大小，不符即失败；
 * - 再流式算 SHA-256 比对（大小写不敏感），不符即失败。
 *
 * 校验失败时删除文件并抛出可读中文错误。
 *
 * @param {string} file
 * @param {{sha256?:string, size?:number}} expected
 * @returns {Promise<{verified:boolean, sha256Checked:boolean, sizeChecked:boolean, bytes:number, sha256:string}>}
 */
async function verifyDownload(file, expected = {}) {
  const expectedSha = normalizeSha256(expected.sha256);
  const rawSize = Number(expected.size);
  const expectedSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.floor(rawSize) : 0;

  // 没有期望哈希就没有校验可言：宁可删掉已下载的包并报错，也不解压未校验的 JDK。
  if (!expectedSha) {
    await fs.rm(file, { force: true }).catch(() => {});
    throw new Error(missingChecksumMessage('下载任务没有可用的 SHA-256 校验值'));
  }

  const stat = await fs.stat(file);
  const bytes = stat.size;

  try {
    if (expectedSize && bytes !== expectedSize) {
      throw new Error(sizeMismatchMessage(expectedSize, bytes));
    }

    const actual = await computeSha256(file);
    if (!sha256Matches(expectedSha, actual)) {
      throw new Error(checksumMismatchMessage(expectedSha, actual));
    }

    return {
      verified: true,
      sha256Checked: true,
      sizeChecked: Boolean(expectedSize),
      bytes,
      sha256: actual
    };
  } catch (error) {
    await fs.rm(file, { force: true }).catch(() => {});
    throw error;
  }
}

// ---------------- 文件 / 进程相关 ----------------

/** 在解压目录里找 bin/java.exe（zip 顶层通常是一个 jdk-21.0.x+y 目录）。 */
async function findJavaExe(root) {
  const direct = path.join(root, 'bin', 'java.exe');
  if (await exists(direct)) return direct;

  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return '';
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, 'bin', 'java.exe');
    if (await exists(candidate)) return candidate;
  }
  return '';
}

function runTar(zipFile, destDir) {
  return new Promise((resolve, reject) => {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const bin = fsSync.existsSync(tar) ? tar : 'tar';
    const child = spawn(bin, ['-xf', zipFile, '-C', destDir], { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`解压 JDK 失败（tar 退出码 ${code}）`));
    });
  });
}

async function downloadToFile(url, file, { onProgress, signal } = {}) {
  const response = await fetch(url, { signal, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`下载 Java 失败（HTTP ${response.status}）`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  if (total > MAX_DOWNLOAD_BYTES) {
    throw new Error(`下载包过大（${formatMb(total)}），已中止`);
  }

  const handle = await fs.open(file, 'w');
  let received = 0;
  let lastReport = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (received > MAX_DOWNLOAD_BYTES) throw new Error('下载包超过大小上限，已中止');
      await handle.write(buffer);

      const now = Date.now();
      if (typeof onProgress === 'function' && now - lastReport > 400) {
        lastReport = now;
        const percent = total ? Math.min(99, Math.round((received / total) * 100)) : null;
        onProgress(
          total
            ? `正在下载 Java ${formatMb(received)} / ${formatMb(total)}（${percent}%）`
            : `正在下载 Java ${formatMb(received)}`,
          percent
        );
      }
    }
  } finally {
    await handle.close();
  }

  if (received < 1024 * 1024) {
    throw new Error('下载到的 Java 安装包异常（文件太小）');
  }
  return received;
}

function isAbortError(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

/**
 * 先查 assets 接口拿 link / checksum / size。
 *
 * 这里**没有降级**：binary/latest 直链既给不出 SHA-256，也给不出字节数，
 * 走那条路等于下载并执行一个未校验的可执行文件。所以任何失败（网络、
 * HTTP 非 2xx、结构变化、没有可用包、缺 checksum）都直接抛可操作的错误，
 * 绝不开始下载。
 *
 * @returns {Promise<{url:string, sha256:string, size:number, degraded:boolean, reason:string}>}
 */
async function resolveDownloadSource(major, { signal, fetchImpl } = {}) {
  // fetchImpl 只是为了单测能注入假响应，正常调用永远是全局 fetch。
  const http = typeof fetchImpl === 'function' ? fetchImpl : fetch;

  let asset;
  try {
    const response = await http(adoptiumAssetsUrl(major), {
      signal,
      redirect: 'follow',
      headers: { accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`assets 接口返回 HTTP ${response.status}`);
    }
    asset = pickAdoptiumAsset(await response.json());
    if (!asset) {
      throw new Error('响应里没有可用的 JDK 包（binary.package 缺失）');
    }
  } catch (error) {
    // 取消必须原样上抛；其它失败一律转成「拿不到校验值 → 中止安装」。
    if (isAbortError(error)) throw error;
    throw new Error(missingChecksumMessage((error && error.message) || String(error)));
  }

  if (!asset.checksum) {
    throw new Error(missingChecksumMessage('binary.package.checksum 为空或不是合法 SHA-256'));
  }

  return {
    url: asset.link,
    sha256: asset.checksum,
    size: asset.size,
    degraded: false,
    reason: ''
  };
}

/** <userData>/java 里已经装好的同主版本（避免重复下载）。 */
async function findInstalled(root, major) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return '';
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!new RegExp(`(^|[-_])${Number(major)}([-_.]|$)`).test(entry.name)) continue;
    const found = await findJavaExe(path.join(root, entry.name));
    if (found) return found;
  }
  return '';
}

/**
 * 安装一个 JDK。
 *
 * 调用链：assets/latest（拿不到 SHA-256 就抛错中止）→ 下载到临时文件
 * → verifyDownload（size + SHA-256，失败删文件并抛错）→ tar 解压 → 定位 java.exe。
 *
 * @param {{major:number, destRoot:string, onProgress?:Function, signal?:AbortSignal}} options
 * @returns {Promise<{javaPath:string, home:string, major:number, url:string, reused:boolean,
 *   downloadedBytes:number, verified:boolean, unverified:boolean, sha256:string}>}
 */
async function installJava(options = {}) {
  const major = SUPPORTED_MAJORS.includes(Number(options.major)) ? Number(options.major) : 21;
  const destRoot = path.resolve(String(options.destRoot || ''));
  if (!destRoot) throw new Error('缺少 Java 安装目录');
  await fs.mkdir(destRoot, { recursive: true });

  const report = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const existing = await findInstalled(destRoot, major);
  if (existing) {
    report(`已存在 Java ${major}：${existing}`, 100);
    return {
      javaPath: existing,
      home: path.dirname(path.dirname(existing)),
      major,
      url: '',
      reused: true,
      downloadedBytes: 0,
      verified: false,
      unverified: false,
      sha256: ''
    };
  }

  report(`正在查询 Adoptium（Java ${major}）…`, null);
  const source = await resolveDownloadSource(major, options);
  const url = source.url;

  if (source.size > MAX_DOWNLOAD_BYTES) {
    throw new Error(`下载包过大（${formatMb(source.size)}），已中止`);
  }

  const work = path.join(destRoot, `.download-${major}-${stamp()}`);
  await fs.mkdir(work, { recursive: true });

  try {
    const zipFile = path.join(work, 'jdk.zip');
    report(`正在下载 Java ${major}…`, null);
    const bytes = await downloadToFile(url, zipFile, options);

    report('下载完成，正在校验 SHA-256…', null);
    const integrity = await verifyDownload(zipFile, {
      sha256: source.sha256,
      size: source.size
    });
    report('校验通过，正在解压…', null);

    const extractDir = path.join(work, 'extract');
    await fs.mkdir(extractDir, { recursive: true });
    await runTar(zipFile, extractDir);

    const javaPath = await findJavaExe(extractDir);
    if (!javaPath) {
      throw new Error('解压后的 JDK 里没有找到 bin/java.exe');
    }

    // 统一放到 <destRoot>/temurin-<major>，重复安装时直接复用这一份。
    const home = path.join(destRoot, `temurin-${major}`);
    if (await exists(home)) {
      await fs.rm(home, { recursive: true, force: true });
    }
    const extractedHome = path.dirname(path.dirname(javaPath));
    try {
      await fs.rename(extractedHome, home);
    } catch {
      await fs.cp(extractedHome, home, { recursive: true });
    }

    const finalPath = path.join(home, 'bin', 'java.exe');
    if (!(await exists(finalPath))) {
      throw new Error('JDK 落盘后找不到 bin/java.exe');
    }

    report(`Java ${major} 已安装（SHA-256 校验通过）：${finalPath}`, 100);

    return {
      javaPath: finalPath,
      home,
      major,
      url,
      reused: false,
      downloadedBytes: bytes,
      verified: true,
      unverified: false,
      sha256: integrity.sha256
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  SUPPORTED_MAJORS,
  MAX_DOWNLOAD_BYTES,
  adoptiumUrl,
  adoptiumAssetsUrl,
  adoptiumArch,
  normalizeSha256,
  sha256Matches,
  pickAdoptiumAsset,
  computeSha256,
  verifyDownload,
  checksumMismatchMessage,
  sizeMismatchMessage,
  missingChecksumMessage,
  resolveDownloadSource,
  installJava,
  findInstalled
};
