'use strict';

/**
 * 原子写：先写同目录下的临时文件 → fsync 落盘 → rename 覆盖目标。
 *
 * 为什么必须这样：
 *   HMCL 曾经在「下载模组 / 更新配置时断电或强杀」之后，把 .minecraft 里的
 *   version.json / mods 变成 0 字节或半截乱码，用户下次启动直接「无法解析版本」。
 *   根因就是直接 `fs.writeFile(target)`：文件被截断后先清空、再慢慢写，
 *   中途任何中断都会留下一个残缺的**目标文件本身**。
 *
 * 这里保证两件事：
 *   1. 目标文件要么是旧内容，要么是新内容的完整版本——不存在中间态；
 *   2. rename 之前先 fsync 临时文件，`--` 断电后不会出现「文件名有了、内容是空的」。
 *
 * 注意：rename 的原子性依赖临时文件和目标在同一分区，所以临时文件必须放在目标目录内
 * （而不是 os.tmpdir()）。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/** 目录 fsync：POSIX 上保证 rename 本身落盘；Windows 不支持对目录 fsync，直接跳过。 */
async function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  let handle = null;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // 目录 fsync 失败不影响正确性（文件本身已经 fsync 过），只是少一层持久性保证。
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function tempNameFor(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const token = crypto.randomBytes(6).toString('hex');
  return path.join(dir, `.${base}.${process.pid}.${token}.tmp`);
}

/**
 * 同一路径的写入串行化。
 *
 * Windows 上两个进程内同时 rename 到同一个目标会拿到 EPERM（共享冲突），
 * 所以「原子」还不够，必须再串行：设置面板连点保存、下载进度回写这类场景
 * 很容易在同一 tick 里触发多次写。
 */
const tails = new Map();
const pending = new Set();

function enqueueForPath(key, task) {
  const previous = tails.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  tails.set(key, tail);
  pending.add(tail);
  const cleanup = () => {
    pending.delete(tail);
    if (tails.get(key) === tail) tails.delete(key);
  };
  tail.then(cleanup, cleanup);
  return run;
}

/**
 * 等待所有排队中的写入落盘（退出时用）。
 *
 * 任务型操作（安装/下载）有 IPC 登记，退出时会被等到；但设置保存、壁纸切换这类
 * 非任务型 IPC 也可能刚好在飞。进程直接退出会留下 .tmp 孤儿（目标文件本身因为
 * rename 原子性不会坏，但清理一下更干净，也确保数据真的落盘）。
 *
 * @returns {Promise<{timedOut: boolean, pending: number}>}
 */
async function flushWrites(timeoutMs = 3000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let timedOut = false;
  while (pending.size > 0) {
    const snapshot = [...pending];
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      break;
    }
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), remaining);
    });
    try {
      const result = await Promise.race([
        Promise.allSettled(snapshot).then(() => 'idle'),
        timeout
      ]);
      if (result === 'timeout') {
        timedOut = true;
        break;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { timedOut, pending: pending.size };
}


const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

/** rename 重试：杀毒软件 / 索引器短暂占用目标文件时会 EPERM，退避重试即可。 */
async function renameWithRetry(from, to, attempts = 5) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE.has(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * (i + 1)));
    }
  }
  throw lastError;
}

/**
 * 原子写文件。
 *
 * @param {string} target 目标路径（会被整体替换）
 * @param {string|Buffer|Uint8Array} data
 * @param {{encoding?: BufferEncoding, mode?: number}} [options]
 */
async function writeFileAtomic(target, data, options = {}) {
  const resolved = path.resolve(target);
  // 同一路径串行：后一次写入排队等前一次彻底落盘，避免 Windows 上的 rename EPERM。
  return enqueueForPath(resolved, () => writeFileAtomicUnsafe(resolved, data, options));
}

async function writeFileAtomicUnsafe(resolved, data, options = {}) {
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });

  const tmp = tempNameFor(resolved);
  const mode = typeof options.mode === 'number' ? options.mode : 0o666;
  let handle = null;

  try {
    handle = await fs.open(tmp, 'wx', mode);
    if (typeof data === 'string') {
      await handle.writeFile(data, options.encoding ? { encoding: options.encoding } : undefined);
    } else {
      await handle.writeFile(data);
    }
    // 关键：先把数据刷到盘上，再让 rename 生效。
    await handle.sync();
    await handle.close();
    handle = null;

    await renameWithRetry(tmp, resolved);
    await syncDirectory(dir);
    return resolved;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    // 失败时清掉临时文件，绝不留下 .tmp 垃圾；目标文件保持原样。
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** 原子写 JSON（默认 2 空格缩进，末尾带换行，跟仓库里其它状态文件的风格一致）。 */
async function writeJsonAtomic(target, value, options = {}) {
  const text = options.compact
    ? JSON.stringify(value)
    : JSON.stringify(value, null, 2) + '\n';
  return writeFileAtomic(target, text, { encoding: 'utf8', mode: options.mode });
}

/**
 * 当前排队中（尚未落盘）的写入数量。
 * 退出流程用它判断「没有任务、但还有写在飞」的情况：那时也必须走收尾，
 * 否则最后一次设置保存会丢（目标文件停在旧值），还会留下 .tmp 孤儿。
 */
function pendingWrites() {
  return pending.size;
}

module.exports = {
  writeFileAtomic,
  writeJsonAtomic,
  flushWrites,
  pendingWrites,
  // 导出给测试用
  _internal: { tempNameFor, syncDirectory, renameWithRetry, pendingCount: () => pending.size }
};
