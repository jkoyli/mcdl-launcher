'use strict';

/**
 * 「设置 → Java 管理 → 安装 Java」的实现。
 *
 * 只做一件最小但完整的事：从 Eclipse Adoptium（Temurin）下载一个指定主版本的
 * Windows JDK、解压到 <userData>/java/、返回 java.exe 路径，由主进程登记授权。
 *
 * 为什么是 Adoptium：公开 API、无需 key、提供稳定的 latest 重定向，
 * 下载文件带 SHA-256 校验值，失败可以直接报错而不是留下半个 JDK。
 *
 * 明确不做：
 *   - 不安装到 C:\Program Files（需要管理员权限）；
 *   - 不修改系统 PATH / JAVA_HOME；
 *   - 不静默替换用户已选的 Java。
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ADOPTIUM_BIN = 'https://api.adoptium.net/v3/binary/latest';
const SUPPORTED_MAJORS = [8, 11, 17, 21, 25];
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;

function adoptiumArch() {
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'ia32') return 'x86';
  return 'x64';
}

function adoptiumUrl(major) {
  const feature = Number(major) || 21;
  return `${ADOPTIUM_BIN}/${feature}/windows/${adoptiumArch()}/jdk/hotspot/normal/eclipse?project=jdk`;
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
 * @param {{major:number, destRoot:string, onProgress?:Function, signal?:AbortSignal}} options
 * @returns {Promise<{javaPath:string, home:string, major:number, url:string, reused:boolean, downloadedBytes:number}>}
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
      downloadedBytes: 0
    };
  }

  const url = adoptiumUrl(major);
  const work = path.join(destRoot, `.download-${major}-${stamp()}`);
  await fs.mkdir(work, { recursive: true });

  try {
    report(`正在连接 Adoptium（Java ${major}）…`, null);
    const zipFile = path.join(work, 'jdk.zip');
    const bytes = await downloadToFile(url, zipFile, options);

    report('下载完成，正在解压…', null);
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

    report(`Java ${major} 已安装：${finalPath}`, 100);
    return { javaPath: finalPath, home, major, url, reused: false, downloadedBytes: bytes };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  SUPPORTED_MAJORS,
  adoptiumUrl,
  installJava,
  findInstalled
};
