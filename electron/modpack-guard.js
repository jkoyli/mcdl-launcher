'use strict';

/**
 * 整合包预检 + 一次性 token + 解压后核对。
 *
 * 为什么不是"必须先经对话框"：拖拽和对话框只是路径来源不同，来源不可控也不代表内容不可控。
 * 渲染进程被 XSS 之后可以伪造任意路径字符串，所以主进程不能信任"用户真的拖了它"，
 * 但可以信任"这个文件必须通过预检才能拿到安装许可"。
 *
 * 流程：
 *   prepare(file)  → 读 zip 中央目录（不执行任何东西）→ 校验条目 → 返回 { token, info }
 *   install(token) → 核对文件指纹 → 交给 mcdl 解压 → verifyExtractedTree 事后核对
 *
 * token 只在主进程内有效、只活 10 分钟、用一次即失效：拿不到 token 就装不了，
 * 而 token 只能由 prepare 产出。这样拖拽入口保留，来源问题变成"内容已过检"。
 *
 * 权威的解压校验在 mcdl（Java 侧，java.util.zip.ZipFile + safeResolve）。这一层的
 * 预检 / 事后核对是纵深防御：它挡的是"恶意的包"和"解压器某天被改坏"。
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { assertLocalPath } = require('./path-guard');

const LIMITS = {
  entries: 20000,                        // 条目数上限（防元数据炸弹）
  totalUncompressed: 16 * 1024 ** 3,     // 解压后总量上限 16 GiB
  singleEntry: 4 * 1024 ** 3,            // 单文件上限 4 GiB
  ratio: 400,                            // 总压缩比上限（防 zip bomb）
  tokenTtlMs: 10 * 60 * 1000
};

const TOKEN_CODE = 'EPACKTOKEN';

/** Windows 上这些名字无法正常创建，出现就说明包在搞事情。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const pending = new Map(); // token -> { file, real, size, mtimeMs, at }

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

/** 读 zip 中央目录：名字、压缩后 / 解压后大小、host OS 与外部属性（判断链接条目）。 */
async function readCentralDirectory(file, limit = LIMITS.entries + 1) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) throw fail('不是有效的 zip 文件');

    const tailLen = Math.min(size, 66 * 1024);
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw fail('不是有效的 zip 文件（找不到中央目录）');

    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (!cdSize || cdOffset >= size) throw fail('不是有效的 zip 文件（中央目录损坏）');

    const cdLen = Math.min(cdSize, 16 * 1024 * 1024);
    const cd = Buffer.alloc(cdLen);
    await handle.read(cd, 0, cdLen, cdOffset);

    const entries = [];
    let p = 0;
    for (let i = 0; i < total && p + 46 <= cd.length; i += 1) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const madeBy = cd.readUInt16LE(p + 4);
      const uncompressed = cd.readUInt32LE(p + 24);
      const compressed = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const externalAttrs = cd.readUInt32LE(p + 38);
      const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');

      entries.push({ name, compressed, uncompressed, madeBy, externalAttrs });
      p += 46 + nameLen + extraLen + commentLen;
      if (entries.length > limit) break;
    }

    return entries;
  } finally {
    await handle.close();
  }
}

/** 条目名是否安全（相对路径、无穿越、无 ADS、无保留名、无尾随空格/点）。 */
function entryProblem(name) {
  if (!name || name.endsWith('/')) return null; // 目录条目无需内容检查

  const normalized = String(name).replace(/\\/g, '/');
  if (normalized.includes('\0')) return '条目名含 NUL';
  if (normalized.startsWith('/')) return '条目使用绝对路径';
  if (/^[A-Za-z]:/.test(normalized)) return '条目带盘符';
  if (normalized.split('/').some((part) => part === '..')) return '条目使用 .. 穿越';
  if (normalized.includes(':')) return '条目名含备选数据流（ADS）';
  if (/(^|\/)\s|\s(\/|$)/.test(normalized)) return '条目名含首尾空格';

  const base = normalized.split('/').pop() || '';
  if (RESERVED.test(base)) return '条目使用 Windows 保留名';
  if (base.endsWith('.') || base.endsWith(' ')) return '条目名以点或空格结尾';
  return null;
}

/** unix 符号链接 / 硬链接判断：host=3(unix) 时高 16 位是 st_mode。 */
function isLinkEntry(entry) {
  const host = (entry.madeBy >> 8) & 0xff;
  const mode = (entry.externalAttrs >>> 16) & 0xffff;
  if (host === 3) {
    const type = mode & 0xf000;
    if (type === 0xa000) return true; // S_IFLNK
    if (type === 0x8000 || type === 0x4000 || type === 0) return false;
    // 其它类型（设备、fifo、socket）也不该出现在整合包里
    return true;
  }
  // Windows 的 reparse point 标记（FILE_ATTRIBUTE_REPARSE_POINT = 0x400）
  return (entry.externalAttrs & 0x400) !== 0;
}

/**
 * 预检：产出安装许可 token。
 * @returns {Promise<{token:string, info:object}>}
 */
async function prepare(file) {
  const resolved = assertLocalPath(file, '整合包路径');

  const stat = await fs.lstat(resolved).catch(() => null);
  if (!stat) throw fail(`找不到整合包文件：${resolved}`);
  if (!stat.isFile()) throw fail('整合包必须是一个普通文件');
  if (stat.size === 0) throw fail('整合包是空文件');
  if (stat.size > LIMITS.totalUncompressed) throw fail('整合包体积过大，已拒绝');

  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.zip' && ext !== '.mrpack') throw fail('只支持 .zip / .mrpack 整合包');

  const entries = await readCentralDirectory(resolved);
  if (entries.length > LIMITS.entries) {
    throw fail(`整合包条目数超过上限（${LIMITS.entries}）`);
  }

  let totalUncompressed = 0;
  let totalCompressed = 0;
  const problems = [];

  for (const entry of entries) {
    const problem = entryProblem(entry.name);
    if (problem) problems.push(`${problem}：${entry.name}`);
    if (isLinkEntry(entry)) problems.push(`链接条目（不允许）：${entry.name}`);

    if (entry.uncompressed > LIMITS.singleEntry) {
      problems.push(`单个文件超过上限：${entry.name}`);
    }
    totalUncompressed += entry.uncompressed;
    totalCompressed += entry.compressed;
  }

  if (totalUncompressed > LIMITS.totalUncompressed) {
    problems.push(`解压后总量超过上限（${Math.round(totalUncompressed / 1024 ** 3)} GiB）`);
  }
  if (totalCompressed > 0 && totalUncompressed / totalCompressed > LIMITS.ratio) {
    problems.push(`压缩比异常（${Math.round(totalUncompressed / totalCompressed)}:1），疑似 zip bomb`);
  }

  if (problems.length > 0) {
    const error = fail(
      `整合包未通过安全检查（${problems.length} 项）：\n` + problems.slice(0, 8).join('\n')
    );
    error.code = 'EPACKUNSAFE';
    error.problems = problems;
    throw error;
  }

  const token = crypto.randomBytes(24).toString('hex');
  pending.set(token, {
    file: resolved,
    real: resolved,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    at: Date.now(),
    entries: entries.length,
    uncompressed: totalUncompressed
  });

  return {
    token,
    info: {
      path: resolved,
      file: path.basename(resolved),
      size: stat.size,
      entryCount: entries.length,
      uncompressedBytes: totalUncompressed,
      manifest: entries
        .map((entry) => entry.name)
        .find((name) => /(^|[\\/])(modrinth|manifest|instance)\.(index\.)?json$/i.test(name)) || ''
    }
  };
}

/** 校验并消费 token（一次性）。 */
function consume(token) {
  const key = String(token || '');
  const record = pending.get(key);
  if (!record) {
    const error = fail('安装许可无效或已使用，请重新选择整合包', TOKEN_CODE);
    throw error;
  }
  pending.delete(key);

  if (Date.now() - record.at > LIMITS.tokenTtlMs) {
    throw fail('安装许可已过期，请重新选择整合包', TOKEN_CODE);
  }
  return record;
}

/** 安装前核对文件没被换掉。 */
async function assertUnchanged(record) {
  const stat = await fs.lstat(record.file).catch(() => null);
  if (!stat || !stat.isFile()) throw fail('整合包文件已被移动或删除');
  if (stat.size !== record.size || Math.round(stat.mtimeMs) !== record.mtimeMs) {
    throw fail('整合包文件在选择之后被修改过，请重新选择', 'EPACKCHANGED');
  }
}

/**
 * 解压后核对：实例目录里不允许出现链接 / reparse point，且文件数与体积在预算内。
 * 这是"解压器某天被改坏"或"mcdl 的 safeResolve 有边界漏洞"的兜底。
 */
async function verifyExtractedTree(root, budget = {}) {
  const maxFiles = budget.maxFiles || LIMITS.entries;
  const maxBytes = budget.maxBytes || LIMITS.totalUncompressed;

  const realRoot = await fs.realpath(root);
  const problems = [];
  let files = 0;
  let bytes = 0;

  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full);

      if (stat.isSymbolicLink()) {
        problems.push(`解压结果里出现符号链接：${path.relative(realRoot, full)}`);
        continue;
      }

      // Windows 的 junction 在 dirent 里既不是目录也不是链接，用 lstat + realpath 兜底。
      const real = await fs.realpath(full).catch(() => null);
      if (!real || (real !== realRoot && !real.startsWith(realRoot + path.sep))) {
        problems.push(`解压结果指到目录外：${path.relative(realRoot, full)}`);
        continue;
      }

      if (stat.isDirectory()) {
        await walk(full);
        continue;
      }

      files += 1;
      bytes += stat.size;
      if (files > maxFiles) problems.push('解压后的文件数超过预算');
      if (bytes > maxBytes) problems.push('解压后的体积超过预算');
    }
  };

  await walk(realRoot);

  if (problems.length > 0) {
    const error = fail(`解压结果未通过核对（${problems.length} 项）：\n` + problems.slice(0, 8).join('\n'));
    error.code = 'EPACKUNSAFE';
    error.problems = problems;
    throw error;
  }

  return { files, bytes };
}

function _resetTokens() {
  pending.clear();
}

module.exports = {
  LIMITS,
  prepare,
  consume,
  assertUnchanged,
  verifyExtractedTree,
  readCentralDirectory,
  entryProblem,
  isLinkEntry,
  _resetTokens
};
