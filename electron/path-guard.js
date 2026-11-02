'use strict';

/**
 * 路径可信度工具。
 *
 * 渲染进程传来的路径一律先过这里，再交给文件系统 / 资源管理器。
 *
 * 分三段，顺序不能换：
 *
 *   1. 词法检查（`assertLocalPath`，纯字符串，不碰文件系统）
 *      拒绝 UNC（`\\server\share`）和设备路径（`\\?\C:\...`、`\\.\...`）。
 *      必须在任何 fs 调用之前做：`fs.stat('\\\\attacker\\share')` 本身就会让
 *      Windows 发起 SMB 认证，NTLM 响应在那一刻就已经发出去了。
 *
 *   2. 规范化 + 越界判定（`assertInsideReal` / `assertInsideAnyRoots`）
 *      用 `fs.realpath` 解析符号链接与 junction（Windows 上 `mklink /J` 不需要管理员权限，
 *      纯字符串的 `path.relative` 判断会被它绕过）；目标不存在时对"最近的已存在祖先"取
 *      realpath 再拼回剩余部分，这样 `mkdir -p` 之前也能判定。
 *
 *   3. 之后才允许 mkdir / stat / openPath。
 *
 * 越界一律抛 code = 'EPATH_OUTSIDE'、消息含 "outside roots" 的错误，
 * 便于测试断言"是因为越界被拒"而不是"因为路径不存在(ENOENT)被拒"。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const OUTSIDE_CODE = 'EPATH_OUTSIDE';

/** `\\server\share` / `//server/share` / `\\?\C:\...` / `\\.\...` 都不是本机普通路径。 */
function isUncOrDevicePath(raw) {
  const value = String(raw == null ? '' : raw);
  return /^[\\/]{2}/.test(value);
}

/**
 * 第一段：词法校验 + 规范化。不碰文件系统。
 * @param {string} raw
 * @param {string} what 报错里用的中文称谓
 * @returns {string} path.resolve 之后的绝对路径
 */
function assertLocalPath(raw, what = '路径') {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) throw new Error(`${what}不能为空`);
  if (value.includes('\0')) throw new Error(`${what}含有非法字符`);
  if (isUncOrDevicePath(value)) {
    throw new Error(`${what}不能是网络路径或设备路径：${value}`);
  }
  if (!path.isAbsolute(value)) throw new Error(`${what}必须是完整路径：${value}`);
  return path.resolve(value);
}

function outsideError(root, target, what) {
  const error = new Error(
    `${what}不在允许的目录范围内（outside roots）：${target}\n允许的根目录：${root}`
  );
  error.code = OUTSIDE_CODE;
  return error;
}

/**
 * 取 target 的"真实路径"：对最近的已存在祖先做 realpath，再把尚不存在的尾部拼回去。
 * 这样既解析了 junction / 符号链接，又不需要目标本身已经存在。
 */
async function realpathNearest(target) {
  const resolved = path.resolve(target);
  const tail = [];
  let current = resolved;

  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** 根目录一般都已存在；不存在就退回词法路径，避免因根还没建就把功能判死。 */
async function realpathRoot(root) {
  try {
    return await fs.realpath(path.resolve(root));
  } catch {
    return path.resolve(root);
  }
}

/** 纯字符串包含判断（严格位于内部，相等不算）。 */
function isInside(root, target) {
  if (!root || !target) return false;
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function relativeInside(root, target) {
  return path.relative(path.resolve(root), path.resolve(target));
}

/**
 * 第二段（单根）：真实路径必须严格位于 root 之内。
 * @returns {Promise<string>} 解析后的真实路径
 */
async function assertInsideReal(root, target, what = '路径') {
  const realRoot = await realpathRoot(root);
  const realTarget = await realpathNearest(target);
  if (!isInside(realRoot, realTarget)) throw outsideError(realRoot, realTarget, what);
  return realTarget;
}

/**
 * 第二段（多根）：真实路径必须位于任一允许根目录之内。
 * @param {string[]} roots
 * @param {string} target
 * @param {string} what
 * @param {{allowEqual?:boolean}} [options] 允许等于根目录本身（例如"打开数据目录"）
 */
async function assertInsideAnyRoots(roots, target, what = '路径', options = {}) {
  const list = (roots || []).filter(Boolean);
  const realTarget = await realpathNearest(target);

  for (const root of list) {
    const realRoot = await realpathRoot(root);
    if (realTarget === realRoot && options.allowEqual) return realTarget;
    if (isInside(realRoot, realTarget)) return realTarget;
  }

  throw outsideError(list.map((root) => path.resolve(root)).join(' | '), realTarget, what);
}

/** 同步版本的包含判断（旧的调用方还在用，语义与 isInside 一致）。 */
function assertInside(root, target, what = '路径') {
  const resolved = path.resolve(target);
  if (!isInside(root, resolved)) throw outsideError(path.resolve(root), resolved, what);
  return resolved;
}

module.exports = {
  OUTSIDE_CODE,
  isUncOrDevicePath,
  assertLocalPath,
  realpathNearest,
  realpathRoot,
  isInside,
  relativeInside,
  assertInside,
  assertInsideReal,
  assertInsideAnyRoots
};
