'use strict';

/**
 * path-guard 测试：路径可信度的三段防线。
 *
 * 这一层是安全关键——渲染进程传来的任何路径都要先过这里，
 * 因此用例重点在"该拒绝的必须拒绝"，并且必须是因为越界被拒（EPATH_OUTSIDE），
 * 而不是因为路径不存在（ENOENT）碰巧失败。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const guard = require('../path-guard');

async function tempDir(t, prefix = 'mcdl-path-guard-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Windows 上创建 junction 不需要管理员权限；其它平台 / 受限环境返回 false。 */
async function tryJunction(target, linkPath) {
  try {
    await fs.symlink(target, linkPath, 'junction');
    return true;
  } catch {
    return false;
  }
}

function isOutsideError(error) {
  assert.equal(error.code, 'EPATH_OUTSIDE');
  assert.match(error.message, /outside roots/);
  return true;
}

// ---------------- 第一段：词法检查 ----------------

test('isUncOrDevicePath：识别 UNC 共享与设备路径', () => {
  assert.equal(guard.isUncOrDevicePath('\\\\server\\share\\pack.zip'), true);
  assert.equal(guard.isUncOrDevicePath('//server/share/pack.zip'), true);
  assert.equal(guard.isUncOrDevicePath('\\\\?\\C:\\Windows\\System32'), true);
  assert.equal(guard.isUncOrDevicePath('\\\\.\\PhysicalDrive0'), true);
  assert.equal(guard.isUncOrDevicePath('\\\\'), true);
});

test('isUncOrDevicePath：本机盘符路径与相对路径不算 UNC', () => {
  assert.equal(guard.isUncOrDevicePath('C:\\Users\\public'), false);
  assert.equal(guard.isUncOrDevicePath('C:/Users/public'), false);
  assert.equal(guard.isUncOrDevicePath('mods\\a.jar'), false);
  assert.equal(guard.isUncOrDevicePath(''), false);
  assert.equal(guard.isUncOrDevicePath(null), false);
  assert.equal(guard.isUncOrDevicePath(undefined), false);
});

test('assertLocalPath：拒绝空路径并给出中文原因', () => {
  assert.throws(() => guard.assertLocalPath(''), /不能为空/);
  assert.throws(() => guard.assertLocalPath('   '), /不能为空/);
  assert.throws(() => guard.assertLocalPath(null), /不能为空/);
  assert.throws(() => guard.assertLocalPath(undefined), /不能为空/);
});

test('assertLocalPath：拒绝含 NUL 的路径（截断攻击）', () => {
  assert.throws(() => guard.assertLocalPath('C:\\games\0\\evil'), /含有非法字符/);
});

test('assertLocalPath：拒绝 UNC 与设备路径，且在网络访问发生前就拒绝', () => {
  assert.throws(() => guard.assertLocalPath('\\\\attacker\\share\\x'), /网络路径或设备路径/);
  assert.throws(() => guard.assertLocalPath('//attacker/share/x'), /网络路径或设备路径/);
  assert.throws(() => guard.assertLocalPath('\\\\?\\C:\\x'), /网络路径或设备路径/);
  assert.throws(() => guard.assertLocalPath('\\\\.\\PhysicalDrive0'), /网络路径或设备路径/);
});

test('assertLocalPath：拒绝相对路径，只接受完整路径', () => {
  assert.throws(() => guard.assertLocalPath('mods\\a.jar'), /必须是完整路径/);
  assert.throws(() => guard.assertLocalPath('.\\game'), /必须是完整路径/);
  assert.throws(() => guard.assertLocalPath('C:relative'), /必须是完整路径/);
});

test('assertLocalPath：合法路径返回 path.resolve 结果，中文与空格保持原样', () => {
  const chinese = 'C:\\用户 目录\\我的世界\\.minecraft';
  assert.equal(guard.assertLocalPath(chinese), path.resolve(chinese));

  // 首尾空白被裁掉，路径内容不受影响
  assert.equal(guard.assertLocalPath('  C:\\games\\mc  '), path.resolve('C:\\games\\mc'));
});

test('assertLocalPath：词法规范化会消掉 ..，但不会因此放行到根目录之外', () => {
  assert.equal(guard.assertLocalPath('C:\\games\\mc\\..\\mc2'), path.resolve('C:\\games\\mc2'));
});

// ---------------- 第二段：包含判断（纯字符串） ----------------

test('isInside：严格位于根目录内部为真', () => {
  assert.equal(guard.isInside('C:\\a', 'C:\\a\\b'), true);
  assert.equal(guard.isInside('C:\\a', 'C:\\a\\b\\c\\d.jar'), true);
});

test('isInside：等于根目录本身不算"在内部"', () => {
  assert.equal(guard.isInside('C:\\a', 'C:\\a'), false);
  assert.equal(guard.isInside('C:\\a\\', 'C:\\a\\'), false);
});

test('isInside：前缀相同但只是兄弟目录时必须为假', () => {
  assert.equal(guard.isInside('C:\\a', 'C:\\ab'), false);
  assert.equal(guard.isInside('C:\\a', 'C:\\ab\\c.jar'), false);
});

test('isInside：.. 穿越与盘符切换一律为假', () => {
  assert.equal(guard.isInside('C:\\a', 'C:\\a\\..\\b'), false);
  assert.equal(guard.isInside('C:\\a', 'C:\\a\\..\\..\\Windows'), false);
  if (process.platform === 'win32') {
    assert.equal(guard.isInside('C:\\a', 'D:\\a\\b'), false);
  }
});

test('isInside：空值不崩溃且判为假', () => {
  assert.equal(guard.isInside('', 'C:\\a'), false);
  assert.equal(guard.isInside('C:\\a', ''), false);
  assert.equal(guard.isInside(null, null), false);
});

test('relativeInside：返回相对路径，越界时以 .. 开头', () => {
  assert.equal(guard.relativeInside('C:\\a', 'C:\\a\\b\\c.jar'), path.join('b', 'c.jar'));
  assert.equal(guard.relativeInside('C:\\a', 'C:\\a'), '');
  assert.ok(guard.relativeInside('C:\\a', 'C:\\b').startsWith('..'));
});

test('assertInside（同步）：越界抛 EPATH_OUTSIDE 并返回规范化路径', () => {
  assert.equal(guard.assertInside('C:\\a', 'C:\\a\\b.jar'), path.resolve('C:\\a\\b.jar'));

  assert.throws(
    () => guard.assertInside('C:\\a', 'C:\\a\\..\\b.jar'),
    isOutsideError
  );
  assert.throws(
    () => guard.assertInside('C:\\a', 'C:\\a'),
    isOutsideError
  );
});

// ---------------- 第二段：真实路径（realpath）判定 ----------------

test('assertInsideReal：存在的内部路径通过，并返回真实路径', async (t) => {
  const root = await tempDir(t);
  const inner = path.join(root, 'mods');
  await fs.mkdir(inner, { recursive: true });
  const file = path.join(inner, 'a.jar');
  await fs.writeFile(file, 'x');

  const resolved = await guard.assertInsideReal(root, file);
  assert.equal(resolved.toLowerCase(), path.resolve(file).toLowerCase());
});

test('assertInsideReal：目标还不存在（mkdir -p 之前的场景）也能判定', async (t) => {
  const root = await tempDir(t);
  const notYet = path.join(root, 'saves', '新 存档', 'level.dat');

  const resolved = await guard.assertInsideReal(root, notYet);
  assert.equal(resolved.toLowerCase(), path.resolve(notYet).toLowerCase());
});

test('assertInsideReal：越界目标抛 EPATH_OUTSIDE（不是 ENOENT）', async (t) => {
  const root = await tempDir(t);
  const outside = path.join(path.dirname(root), 'outside-file.txt');

  await assert.rejects(guard.assertInsideReal(root, outside), isOutsideError);
  await assert.rejects(guard.assertInsideReal(root, path.join(root, '..', 'x')), isOutsideError);
});

test('assertInsideReal：等于根目录本身被拒绝（必须严格在其内部）', async (t) => {
  const root = await tempDir(t);
  await assert.rejects(guard.assertInsideReal(root, root), isOutsideError);
});

test('assertInsideReal：junction 指向目录外时被拦截（字符串判断挡不住的绕过）', async (t) => {
  const root = await tempDir(t);
  const outside = await tempDir(t);
  await fs.writeFile(path.join(outside, 'secret.txt'), 's');

  const link = path.join(root, 'escape');
  if (!(await tryJunction(outside, link))) {
    t.skip('当前环境无法创建 junction / 符号链接');
    return;
  }

  // 纯字符串判断会认为它在 root 内
  assert.equal(guard.isInside(root, path.join(link, 'secret.txt')), true);

  await assert.rejects(guard.assertInsideReal(root, path.join(link, 'secret.txt')), isOutsideError);
});

test('assertInsideReal：junction 指向目录内时照常放行', async (t) => {
  const root = await tempDir(t);
  const inner = path.join(root, 'real');
  await fs.mkdir(inner, { recursive: true });
  await fs.writeFile(path.join(inner, 'a.jar'), 'x');

  const link = path.join(root, 'alias');
  if (!(await tryJunction(inner, link))) {
    t.skip('当前环境无法创建 junction / 符号链接');
    return;
  }

  const resolved = await guard.assertInsideReal(root, path.join(link, 'a.jar'));
  assert.equal(resolved.toLowerCase(), path.join(inner, 'a.jar').toLowerCase());
});

test('realpathNearest：不存在的尾部原样拼回最近的已存在祖先', async (t) => {
  const root = await tempDir(t);
  const target = path.join(root, 'a', 'b', 'c.txt');
  const resolved = await guard.realpathNearest(target);
  assert.equal(resolved.toLowerCase(), path.resolve(target).toLowerCase());
});

test('realpathRoot：根目录不存在时退回词法路径，不抛错', async (t) => {
  const root = await tempDir(t);
  const missingRoot = path.join(root, '还没建的根');
  const resolved = await guard.realpathRoot(missingRoot);
  assert.equal(resolved.toLowerCase(), path.resolve(missingRoot).toLowerCase());
});

test('assertInsideAnyRoots：命中任一允许根目录即通过', async (t) => {
  const rootA = await tempDir(t);
  const rootB = await tempDir(t);
  const target = path.join(rootB, 'packs', 'a.zip');

  const resolved = await guard.assertInsideAnyRoots([rootA, rootB], target, '整合包');
  assert.equal(resolved.toLowerCase(), path.resolve(target).toLowerCase());
});

test('assertInsideAnyRoots：全部不命中时抛 EPATH_OUTSIDE', async (t) => {
  const rootA = await tempDir(t);
  const rootB = await tempDir(t);
  const target = path.join(path.dirname(rootA), 'evil.zip');

  await assert.rejects(
    guard.assertInsideAnyRoots([rootA, rootB], target, '整合包'),
    isOutsideError
  );

  // 空根目录列表同样拒绝，不能因为"没有配根"就放行
  await assert.rejects(guard.assertInsideAnyRoots([], target, '整合包'), isOutsideError);
  await assert.rejects(guard.assertInsideAnyRoots(null, target, '整合包'), isOutsideError);
});

test('assertInsideAnyRoots：allowEqual 决定根目录本身是否放行', async (t) => {
  const root = await tempDir(t);

  await assert.rejects(guard.assertInsideAnyRoots([root], root, '数据目录'), isOutsideError);

  const resolved = await guard.assertInsideAnyRoots([root], root, '数据目录', { allowEqual: true });
  assert.equal(resolved.toLowerCase(), path.resolve(root).toLowerCase());
});
