'use strict';

/**
 * instance-store 测试：实例级设置（内存 / Java / JVM 参数）、图标与内容目录管理。
 *
 * 重点在两处安全边界：内容目录的解析规则（版本隔离 vs 全局）与
 * 「启停 / 删除前必须确认目标在该目录内」——这两条错了就是删错文件。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createInstanceStore, CONTENT_DIRS } = require('../instance-store');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-instance-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFileWithDirs(file, content = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function setup(t) {
  const root = await tempDir(t);
  const storeDir = path.join(root, 'data');
  const gameDir = path.join(root, 'game');
  const versionDir = path.join(gameDir, 'versions', '1.20.1');
  await fs.mkdir(versionDir, { recursive: true });

  const store = createInstanceStore({ storeDir, launcherHome: root });
  return { root, storeDir, gameDir, versionDir, store };
}

function isOutsideError(error) {
  assert.equal(error.code, 'EPATH_OUTSIDE');
  assert.match(error.message, /outside roots/);
  return true;
}

// ---------------- 实例设置 ----------------

test('getSettings：没有配置时返回空对象', async (t) => {
  const { store, versionDir } = await setup(t);
  assert.deepEqual(await store.getSettings(versionDir), {});
});

test('saveSettings：只覆盖 patch 里出现的字段，并做取整', async (t) => {
  const { store, versionDir } = await setup(t);

  await store.saveSettings(versionDir, { memoryMb: 4096.4, width: 1280, height: 720 });
  assert.deepEqual(await store.getSettings(versionDir), {
    memoryMb: 4096,
    width: 1280,
    height: 720
  });

  // 只改内存，其它字段保持不变
  await store.saveSettings(versionDir, { memoryMb: 8192 });
  assert.deepEqual(await store.getSettings(versionDir), {
    memoryMb: 8192,
    width: 1280,
    height: 720
  });
});

test('saveSettings：空值表示"改回继承全局"，对应字段被删除', async (t) => {
  const { store, versionDir } = await setup(t);

  await store.saveSettings(versionDir, {
    memoryMb: 2048,
    javaPath: 'C:\\Java\\bin\\java.exe',
    jvmArgs: '-XX:+UseG1GC'
  });

  await store.saveSettings(versionDir, { memoryMb: '', javaPath: '   ', jvmArgs: '' });
  assert.deepEqual(await store.getSettings(versionDir), {});
});

test('saveSettings：非法数字被忽略而不是写进配置', async (t) => {
  const { store, versionDir } = await setup(t);

  await store.saveSettings(versionDir, { memoryMb: 'abc', width: -1, height: NaN });
  assert.deepEqual(await store.getSettings(versionDir), {});

  await store.saveSettings(versionDir, { jvmArgs: '  -Xmx512M  ' });
  assert.deepEqual(await store.getSettings(versionDir), { jvmArgs: '-Xmx512M' });
});

test('getSettings：读取时会清洗磁盘上的脏数据', async (t) => {
  const { store, storeDir, versionDir } = await setup(t);
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(
    path.join(storeDir, 'instance-settings.json'),
    JSON.stringify({
      [path.resolve(versionDir)]: {
        memoryMb: 'abc',
        width: 1280.6,
        height: -5,
        javaPath: '  C:\\Java\\bin\\java.exe  ',
        jvmArgs: '   '
      }
    }),
    'utf8'
  );

  assert.deepEqual(await store.getSettings(versionDir), {
    width: 1281,
    javaPath: 'C:\\Java\\bin\\java.exe'
  });
});

test('saveSettings：写入磁盘后能被新的 store 实例读回', async (t) => {
  const { store, storeDir, versionDir } = await setup(t);
  await store.saveSettings(versionDir, { memoryMb: 6144 });

  const reopened = createInstanceStore({ storeDir, launcherHome: path.dirname(storeDir) });
  assert.deepEqual(await reopened.getSettings(versionDir), { memoryMb: 6144 });
});

test('saveSettings：所有字段都清空后，配置里不再留下空对象', async (t) => {
  const { store, storeDir, versionDir } = await setup(t);
  await store.saveSettings(versionDir, { memoryMb: 1024 });
  await store.saveSettings(versionDir, { memoryMb: '' });

  const raw = JSON.parse(await fs.readFile(path.join(storeDir, 'instance-settings.json'), 'utf8'));
  assert.deepEqual(raw, {});
});

// ---------------- 隔离策略 ----------------

test('隔离策略：非法值回落到 auto，合法值可读回', async (t) => {
  const { store } = await setup(t);

  assert.equal(store.getIsolationMode(), 'auto');
  assert.equal(store.setIsolationMode('isolated'), 'isolated');
  assert.equal(store.getIsolationMode(), 'isolated');
  assert.equal(store.setIsolationMode('乱写'), 'auto');
  assert.equal(store.setIsolationMode('global'), 'global');
});

test('隔离策略 isolated：内容目录落在版本目录下（版本隔离）', async (t) => {
  const { store, versionDir, gameDir } = await setup(t);
  await fs.mkdir(path.join(gameDir, 'mods'), { recursive: true });

  store.setIsolationMode('isolated');
  const instance = { path: versionDir, gameDir };

  const root = await store.folderFor(instance, 'mods');
  assert.equal(root.toLowerCase(), path.join(versionDir, 'mods').toLowerCase());
  assert.equal((await fs.stat(root)).isDirectory(), true);
});

test('隔离策略 global：内容目录落在游戏目录下（全局）', async (t) => {
  const { store, versionDir, gameDir } = await setup(t);
  store.setIsolationMode('global');

  const root = await store.folderFor({ path: versionDir, gameDir }, 'mods');
  assert.equal(root.toLowerCase(), path.join(gameDir, 'mods').toLowerCase());
});

test('隔离策略 auto：优先沿用已存在的目录', async (t) => {
  const { store, versionDir, gameDir } = await setup(t);
  await fs.mkdir(path.join(gameDir, 'mods'), { recursive: true });

  const root = await store.folderFor({ path: versionDir, gameDir }, 'mods');
  assert.equal(root.toLowerCase(), path.join(gameDir, 'mods').toLowerCase());
});

test('listContent：只读固定内容目录，跳过以点开头的项', async (t) => {
  const { store, gameDir, versionDir } = await setup(t);
  const mods = path.join(gameDir, 'mods');
  await writeFileWithDirs(path.join(mods, 'a.jar'), 'aaaa');
  await writeFileWithDirs(path.join(mods, 'b.jar.disabled'), 'bb');
  await writeFileWithDirs(path.join(mods, '.hidden.jar'), 'h');

  const listed = await store.listContent({ path: versionDir, gameDir }, 'mods');
  assert.equal(listed.exists, true);
  assert.deepEqual(listed.entries.map((entry) => entry.name), ['a.jar', 'b.jar']);
  assert.equal(listed.entries[0].enabled, true);
  assert.equal(listed.entries[1].enabled, false);
  assert.equal(listed.entries[1].rawName, 'b.jar.disabled');
  assert.equal(listed.entries[0].size, 4);
});

test('listContent：非 mods 类型直接忽略 .disabled 文件', async (t) => {
  const { store, gameDir, versionDir } = await setup(t);
  await writeFileWithDirs(path.join(gameDir, 'config', 'x.cfg'));
  await writeFileWithDirs(path.join(gameDir, 'config', 'y.cfg.disabled'));

  const listed = await store.listContent({ path: versionDir, gameDir }, 'config');
  assert.deepEqual(listed.entries.map((entry) => entry.name), ['x.cfg']);
  assert.equal(listed.entries[0].enabled, true);
});

test('listContent：目录不存在时 exists=false 且不抛错', async (t) => {
  const { store, gameDir, versionDir } = await setup(t);
  const listed = await store.listContent({ path: versionDir, gameDir }, 'resourcepacks');
  assert.equal(listed.exists, false);
  assert.deepEqual(listed.entries, []);
});

test('listContent / folderFor：不支持的内容类型报错', async (t) => {
  const { store, gameDir, versionDir } = await setup(t);
  await assert.rejects(store.listContent({ path: versionDir, gameDir }, 'windows-system32'), /不支持的内容类型/);
  await assert.rejects(store.folderFor({ path: versionDir, gameDir }, 'nope'), /不支持的内容类型/);
});

test('CONTENT_DIRS：只暴露已知的内容目录名', () => {
  assert.equal(CONTENT_DIRS.mods, 'mods');
  assert.equal(CONTENT_DIRS.screenshots, 'screenshots');
  assert.equal(CONTENT_DIRS['crash-reports'], 'crash-reports');
  assert.equal(CONTENT_DIRS.nope, undefined);
});

// ---------------- 启停 / 删除的路径校验 ----------------

test('setModEnabled：重命名加 / 去掉 .disabled，可反复切换', async (t) => {
  const { store, gameDir, versionDir } = await setup(t);
  const mods = path.join(gameDir, 'mods');
  const file = path.join(mods, 'a.jar');
  await writeFileWithDirs(file, 'jar');

  const disabled = await store.setModEnabled({ path: versionDir, gameDir }, file, false);
  assert.equal(disabled.enabled, false);
  assert.equal(path.basename(disabled.path), 'a.jar.disabled');
  assert.equal((await fs.stat(file).catch(() => null)), null);

  // 重复禁用是幂等的
  const again = await store.setModEnabled({ path: versionDir, gameDir }, disabled.path, false);
  assert.equal(again.enabled, false);

  const enabled = await store.setModEnabled({ path: versionDir, gameDir }, disabled.path, true);
  assert.equal(enabled.enabled, true);
  assert.equal(path.basename(enabled.path), 'a.jar');
  assert.equal((await fs.stat(file)).isFile(), true);
});

test('setModEnabled：目标在 mods 目录外时拒绝（不能改任意文件的后缀）', async (t) => {
  const { store, root, gameDir, versionDir } = await setup(t);
  await fs.mkdir(path.join(gameDir, 'mods'), { recursive: true });
  const victim = path.join(root, 'important.cfg');
  await fs.writeFile(victim, 'x');

  await assert.rejects(
    store.setModEnabled({ path: versionDir, gameDir }, victim, false),
    isOutsideError
  );
  assert.equal((await fs.stat(victim)).isFile(), true, '目标文件必须保持原样');
});

test('deleteContent：只允许删除内容目录内的文件', async (t) => {
  const { store, root, gameDir, versionDir } = await setup(t);
  const mods = path.join(gameDir, 'mods');
  const inside = path.join(mods, 'a.jar');
  await writeFileWithDirs(inside, 'jar');

  const victim = path.join(root, '重要文件.txt');
  await fs.writeFile(victim, 'x');

  await assert.rejects(
    store.deleteContent({ instance: { path: versionDir, gameDir }, kind: 'mods', target: victim }),
    isOutsideError
  );
  assert.equal((await fs.stat(victim)).isFile(), true);

  assert.equal(
    await store.deleteContent({ instance: { path: versionDir, gameDir }, kind: 'mods', target: inside }),
    true
  );
  assert.equal(await fs.stat(inside).catch(() => null), null);
});

test('deleteContent：.. 穿越到内容目录之外时拒绝', async (t) => {
  const { store, gameDir, versionDir } = await setup(t);
  const mods = path.join(gameDir, 'mods');
  await fs.mkdir(mods, { recursive: true });

  await assert.rejects(
    store.deleteContent({
      instance: { path: versionDir, gameDir },
      kind: 'mods',
      target: path.join(mods, '..', 'options.txt')
    }),
    isOutsideError
  );
});

test('importContent：重名时自动加序号，不覆盖已有文件', async (t) => {
  const { store, root, gameDir, versionDir } = await setup(t);
  const source = path.join(root, '导入源', 'a.jar');
  await writeFileWithDirs(source, 'new');

  const imported = await store.importContent({
    instance: { path: versionDir, gameDir },
    kind: 'mods',
    sourcePaths: [source, source]
  });

  assert.equal(imported.length, 2);
  assert.equal(path.basename(imported[0]), 'a.jar');
  assert.equal(path.basename(imported[1]), 'a (1).jar');
  assert.equal(await fs.readFile(imported[1], 'utf8'), 'new');
});

// ---------------- 图标 ----------------

test('图标：内置图标可读写并清除', async (t) => {
  const { store, versionDir } = await setup(t);

  assert.equal(await store.getIcon(versionDir), null);

  await store.setBuiltinIcon(versionDir, 'grass');
  assert.deepEqual(await store.getIcon(versionDir), { type: 'builtin', key: 'grass' });

  await store.clearIcon(versionDir);
  assert.equal(await store.getIcon(versionDir), null);
});

test('图标：自定义图片落到 icons/ 并返回可用的 data URL', async (t) => {
  const { store, root, storeDir, versionDir } = await setup(t);
  const source = path.join(root, 'icon.png');
  await fs.writeFile(source, Buffer.from('PNGDATA'));

  const result = await store.setFileIcon(versionDir, source);
  assert.equal(result.icon.type, 'file');
  assert.match(result.icon.file, /^[0-9a-f]{16}\.png$/);
  assert.equal(result.dataUrl, `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`);

  assert.equal((await fs.stat(path.join(storeDir, 'icons', result.icon.file))).isFile(), true);

  const loaded = await store.iconData(versionDir);
  assert.equal(loaded.dataUrl, result.dataUrl);
});

test('图标：空文件、非法扩展名、过大文件都被拒绝', async (t) => {
  const { store, root, versionDir } = await setup(t);

  const empty = path.join(root, 'empty.png');
  await fs.writeFile(empty, Buffer.alloc(0));
  await assert.rejects(store.setFileIcon(versionDir, empty), /图标文件是空的/);

  const txt = path.join(root, 'notes.txt');
  await fs.writeFile(txt, 'hello');
  await assert.rejects(store.setFileIcon(versionDir, txt), /需要是 PNG \/ JPG \/ WebP \/ GIF/);

  const huge = path.join(root, 'huge.png');
  await fs.writeFile(huge, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(store.setFileIcon(versionDir, huge), /不能超过 4 MB/);
});

test('图标：图标文件被删掉时 iconData 返回 null 而不是抛错', async (t) => {
  const { store, root, storeDir, versionDir } = await setup(t);
  const source = path.join(root, 'icon.png');
  await fs.writeFile(source, Buffer.from('PNGDATA'));

  const { icon } = await store.setFileIcon(versionDir, source);
  await fs.rm(path.join(storeDir, 'icons', icon.file));

  const loaded = await store.iconData(versionDir);
  assert.equal(loaded.dataUrl, null);
  assert.deepEqual(loaded.icon, icon);
});
