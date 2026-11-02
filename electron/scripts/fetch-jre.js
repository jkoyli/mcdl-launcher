'use strict';

/**
 * 下载内置 JRE（Eclipse Temurin 21，Windows x64）到 electron/jre/。
 *
 * 打包时 electron-builder 会把 electron/jre/ 通过 extraResources 复制到
 * <resources>/jre/，运行时由 java-runtime.bundledJava() 优先使用，
 * 用户机器完全没装 Java 也能跑 mcdl（版本列表 / 安装 / 扫描）。
 *
 * 用法：
 *   npm run fetch:jre            已有的 JRE 直接跳过（幂等）
 *   npm run fetch:jre -- --force 重新下载覆盖
 *
 * 实现要点：
 *   - 走 Adoptium 的 binary/latest 直链（跟随 302 到 GitHub release）；
 *   - **流式**写临时文件，不把几十 MB 的包整个读进内存；
 *   - 用系统自带的 tar.exe（Windows 10+ 是 bsdtar，能解 zip），
 *     解完剥掉压缩包的顶层目录，最终必须是 electron/jre/bin/java.exe。
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const JRE_MAJOR = 21;
const DOWNLOAD_URL =
  `https://api.adoptium.net/v3/binary/latest/${JRE_MAJOR}/ga/windows/x64/jre/hotspot/normal/eclipse`;
const JRE_DIR = path.join(__dirname, '..', 'jre');
const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

function formatMb(bytes) {
  return (Number(bytes || 0) / (1024 * 1024)).toFixed(1) + ' MB';
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function stamp() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 系统的 tar.exe（Windows 10+ 自带 bsdtar，能直接解 zip）。 */
function tarBinary() {
  const absolute = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fsSync.existsSync(absolute) ? absolute : 'tar';
}

/**
 * 流式下载到文件，并把进度打到控制台。
 * @param {string} url
 * @param {string} file
 * @returns {Promise<number>} 下载字节数
 */
async function downloadToFile(url, file) {
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    throw new Error(`下载 JRE 失败：${error.message}（请检查网络 / 代理设置）`);
  }

  if (!response.ok) {
    throw new Error(`下载 JRE 失败（HTTP ${response.status} ${response.statusText || ''}）`.trim());
  }
  if (!response.body) {
    throw new Error('下载 JRE 失败：服务器没有返回内容（可能是镜像/代理拦截）');
  }

  const total = Number(response.headers.get('content-length')) || 0;
  if (total > MAX_DOWNLOAD_BYTES) {
    throw new Error(`JRE 安装包过大（${formatMb(total)}），已中止`);
  }

  const handle = await fs.open(file, 'w');
  let received = 0;
  let lastReport = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (received > MAX_DOWNLOAD_BYTES) {
        throw new Error('JRE 安装包超过大小上限，已中止');
      }
      await handle.write(buffer);

      const now = Date.now();
      if (now - lastReport > 500) {
        lastReport = now;
        const percent = total ? `（${Math.min(99, Math.round((received / total) * 100))}%）` : '';
        console.log(`  下载中：${formatMb(received)}${total ? ` / ${formatMb(total)}` : ''}${percent}`);
      }
    }
  } finally {
    await handle.close();
  }

  if (received < 1024 * 1024) {
    throw new Error(`下载到的 JRE 安装包异常（只有 ${formatMb(received)}）`);
  }
  return received;
}

/** 用 tar -xf 解压；失败时带上 stderr 最后几行。 */
function extractZip(zipFile, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarBinary(), ['-xf', zipFile, '-C', destDir], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => reject(new Error(`无法启动 tar：${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ');
      reject(new Error(`解压 JRE 失败（tar 退出码 ${code}）${detail ? `：${detail}` : ''}`));
    });
  });
}

/** 在解压目录里找 bin/java.exe，返回它的 JRE 根目录（自动剥掉顶层目录）。 */
async function findJavaHome(root) {
  const direct = path.join(root, 'bin', JAVA_EXE);
  if (await exists(direct)) return root;

  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return '';
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (await exists(path.join(candidate, 'bin', JAVA_EXE))) return candidate;
  }
  return '';
}

/** 把解出来的 JRE 根目录搬到 electron/jre（跨分区 rename 失败时退回递归复制）。 */
async function installJavaHome(sourceHome) {
  await fs.mkdir(path.dirname(JRE_DIR), { recursive: true });
  if (await exists(JRE_DIR)) {
    await fs.rm(JRE_DIR, { recursive: true, force: true });
  }

  try {
    await fs.rename(sourceHome, JRE_DIR);
  } catch {
    await fs.cp(sourceHome, JRE_DIR, { recursive: true });
    await fs.rm(sourceHome, { recursive: true, force: true }).catch(() => {});
  }

  const javaPath = path.join(JRE_DIR, 'bin', JAVA_EXE);
  if (!(await exists(javaPath))) {
    throw new Error(`JRE 落盘后找不到 bin/${JAVA_EXE}：${javaPath}`);
  }
  return javaPath;
}

async function main() {
  const force = process.argv.includes('--force');

  if (process.platform !== 'win32') {
    console.warn('[fetch:jre] 警告：这个脚本下载的是 Windows x64 的 JRE，当前系统不是 Windows。');
  }

  const existing = path.join(JRE_DIR, 'bin', JAVA_EXE);
  if (!force && (await exists(existing))) {
    console.log(`[fetch:jre] 已存在内置 JRE，跳过：${existing}`);
    console.log('[fetch:jre] 需要重新下载请加 --force。');
    return;
  }

  console.log(`[fetch:jre] 下载 Temurin JRE ${JRE_MAJOR}（Windows x64）…`);
  console.log(`[fetch:jre] ${DOWNLOAD_URL}`);

  const work = path.join(os.tmpdir(), `mcdl-fetch-jre-${stamp()}`);
  await fs.mkdir(work, { recursive: true });

  try {
    const zipFile = path.join(work, 'jre.zip');
    const bytes = await downloadToFile(DOWNLOAD_URL, zipFile);
    console.log(`[fetch:jre] 下载完成：${formatMb(bytes)}`);

    const extractDir = path.join(work, 'extract');
    await fs.mkdir(extractDir, { recursive: true });
    console.log('[fetch:jre] 解压中…');
    await extractZip(zipFile, extractDir);

    const home = await findJavaHome(extractDir);
    if (!home) {
      throw new Error(`解压后的压缩包里没有 bin/${JAVA_EXE}，包结构可能变了`);
    }

    const javaPath = await installJavaHome(home);
    console.log(`[fetch:jre] 完成：${javaPath}`);
    console.log('[fetch:jre] 重新打包（npm run dist:dir / dist）后即会带上这个 JRE。');
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[fetch:jre] 失败：${error && error.message ? error.message : error}`);
  console.error('[fetch:jre] 可以重试；仍失败时可手动下载 JRE 21 解压到 electron/jre/（保证有 bin/java.exe）。');
  process.exitCode = 1;
});
