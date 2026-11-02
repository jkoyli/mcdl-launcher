'use strict';

/**
 * game-directories 测试：游戏目录列表的增删改、去重与相对路径展示。
 *
 * 都是用临时目录驱动的真实文件系统调用（不 mock fs），
 * 因为这一层的 bug 几乎都出在"目录建没建""配置有没有落盘""primary 有没有断"。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createGameDirectoryStore } = require('../game-directories');

const EXPECTED_SUBDIRS = [
  'versions', 'libraries', 'assets', 'logs',
  'mods', 'saves', 'resourcepacks', 'shaderpacks'
];

async function makeStore(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-game-dirs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const launcherHome = path.join(root, 'launcher');
  const storeDir = path.join(root, 'data');
  const defaultDir = options.defaultDir || path.join(launcherHome, 'game');

  const store = createGameDirectoryStore({
    storeDir,
    defaultDir,
    launcherHome: options.launcherHome === undefined ? launcherHome : options.launcherHome
  });

  return { root, launcherHome, storeDir, defaultDir, store };
}

test('list：首次运行用默认目录播种，并标记为 primary', async (t) => {
  const { store, defaultDir } = await makeStore(t);

  const listed = await store.list();
  assert.equal(listed.dirs.length, 1);
  assert.equal(listed.dirs[0].path, path.resolve(defaultDir));
  assert.equal(listed.dirs[0].primary, true);
  assert.equal(listed.dirs[0].useRelativePath, false);
  assert.match(listed.dirs[0].id, /^[0-9a-f]{12}$/);
});

test('list：播种结果立即落盘到 game-directories.json', async (t) => {
  const { store, storeDir } = await makeStore(t);
  await store.list();

  const raw = JSON.parse(await fs.readFile(path.join(storeDir, 'game-directories.json'), 'utf8'));
  assert.equal(raw.dirs.length, 1);
  assert.equal(raw.dirs[0].primary, true);
});

test('save：新增目录时补齐标准子目录并写入启动器标记文件', async (t) => {
  const { store, root } = await makeStore(t);
  const dirPath = path.join(root, '另一个 游戏 目录');

  const result = await store.save({ dirPath, useRelativePath: false });
  assert.equal(result.dirs.length, 2);

  const added = result.dirs.find((entry) => entry.path === path.resolve(dirPath));
  assert.ok(added, '应返回新增的目录');
  assert.equal(added.primary, false);

  for (const sub of EXPECTED_SUBDIRS) {
    const stat = await fs.stat(path.join(dirPath, sub));
    assert.equal(stat.isDirectory(), true, `应创建子目录 ${sub}`);
  }

  const marker = JSON.parse(await fs.readFile(path.join(dirPath, 'mcdl-launcher.json'), 'utf8'));
  assert.equal(marker.launcher, 'MCDL Launcher');
});

test('save：同一目录（仅大小写不同）不允许重复添加', async (t) => {
  const { store, defaultDir } = await makeStore(t);

  if (process.platform !== 'win32') {
    // 大小写敏感文件系统上这不是"同一个目录"，跳过这条 Windows 语义的检查
    t.skip('仅在大小写不敏感的 Windows 上验证');
    return;
  }

  await assert.rejects(
    store.save({ dirPath: defaultDir.toLowerCase() }),
    /已经在列表里了/
  );
});

test('save：空路径与相对路径被拒绝', async (t) => {
  const { store } = await makeStore(t);

  await assert.rejects(store.save({ dirPath: '' }), /请填写游戏文件夹路径/);
  await assert.rejects(store.save({ dirPath: '   ' }), /请填写游戏文件夹路径/);
  await assert.rejects(store.save({ dirPath: 'game' }), /请填写完整路径/);
});

test('save：目标是已存在的文件时拒绝（不能把文件当目录）', async (t) => {
  const { store, root } = await makeStore(t);
  const file = path.join(root, 'not-a-dir.txt');
  await fs.writeFile(file, 'x');

  await assert.rejects(store.save({ dirPath: file }), /不是文件夹/);
});

test('displayPath：开启相对路径且位于启动器目录内时显示相对路径', async (t) => {
  const { store, launcherHome } = await makeStore(t);
  const inside = path.join(launcherHome, 'pack');
  await store.save({ dirPath: inside, useRelativePath: true });

  const listed = await store.list();
  const entry = listed.dirs.find((item) => item.path === path.resolve(inside));
  assert.equal(entry.relativePossible, true);
  assert.equal(entry.displayPath, path.join('pack'));
});

test('displayPath：位于启动器目录外时仍显示绝对路径', async (t) => {
  const { store, root } = await makeStore(t);
  const outside = path.join(root, '外部 目录');
  await store.save({ dirPath: outside, useRelativePath: true });

  const listed = await store.list();
  const entry = listed.dirs.find((item) => item.path === path.resolve(outside));
  assert.equal(entry.relativePossible, false);
  assert.equal(entry.displayPath, path.resolve(outside));
});

test('save + list：配置能跨 store 实例持久化', async (t) => {
  const { store, root, storeDir, launcherHome, defaultDir } = await makeStore(t);
  const dirPath = path.join(root, '持久化目录');
  await store.save({ dirPath, useRelativePath: true });

  const reopened = createGameDirectoryStore({ storeDir, defaultDir, launcherHome });
  const listed = await reopened.list();

  assert.equal(listed.dirs.length, 2);
  const entry = listed.dirs.find((item) => item.path === path.resolve(dirPath));
  assert.ok(entry, '重新打开后应仍能看到新增目录');
  assert.equal(entry.useRelativePath, true);
});

test('save：带 id 时更新已有条目（路径与 id 一起更新）', async (t) => {
  const { store, root } = await makeStore(t);
  const first = path.join(root, '第一个');
  const second = path.join(root, '第二个');

  const created = await store.save({ dirPath: first });
  const id = created.dir.id;

  const updated = await store.save({ id, dirPath: second, useRelativePath: true });
  assert.equal(updated.dirs.length, 2, '更新不应该新增条目');

  const entry = updated.dirs.find((item) => item.path === path.resolve(second));
  assert.ok(entry);
  assert.equal(entry.useRelativePath, true);
  assert.notEqual(entry.id, id, '路径变了，id 应当跟着重算');

  assert.equal(updated.dirs.some((item) => item.path === path.resolve(first)), false);
});

test('remove：删除后 primary 顺延给剩下的第一个', async (t) => {
  const { store, root } = await makeStore(t);
  const listed = await store.list();
  const primary = listed.dirs.find((item) => item.primary);

  await store.save({ dirPath: path.join(root, '备用目录') });

  const afterRemove = await store.remove(primary.id);
  assert.equal(afterRemove.dirs.length, 1);
  assert.equal(afterRemove.dirs[0].primary, true);
});

test('remove：最后一个目录不允许删除', async (t) => {
  const { store, root } = await makeStore(t);
  const listed = await store.list();
  const primary = listed.dirs.find((item) => item.primary);
  const extra = await store.save({ dirPath: path.join(root, '再来一个') });
  const extraEntry = extra.dirs.find((item) => !item.primary);

  await store.remove(primary.id);
  await assert.rejects(store.remove(extraEntry.id), /至少要保留一个游戏文件夹/);
});

test('remove：不存在的 id 报错', async (t) => {
  const { store } = await makeStore(t);
  await assert.rejects(store.remove('nope'), /游戏目录不存在/);
  await assert.rejects(store.remove(''), /游戏目录不存在/);
});

test('paths 与 primaryPath：只暴露扫描需要的绝对路径', async (t) => {
  const { store, root, defaultDir } = await makeStore(t);
  const extra = path.join(root, '扫描目录');
  await store.save({ dirPath: extra, useRelativePath: true });

  assert.deepEqual(await store.paths(), [path.resolve(defaultDir), path.resolve(extra)]);
  assert.equal(await store.primaryPath(), path.resolve(defaultDir));
});

test('load：配置文件损坏时退回默认目录而不是崩掉', async (t) => {
  const { store, storeDir, defaultDir } = await makeStore(t);
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(storeDir, 'game-directories.json'), '{ 不是合法 JSON', 'utf8');

  const listed = await store.list();
  assert.equal(listed.dirs.length, 1);
  assert.equal(listed.dirs[0].path, path.resolve(defaultDir));
});
