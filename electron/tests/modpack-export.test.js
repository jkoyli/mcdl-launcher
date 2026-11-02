'use strict';

/**
 * modpack-export 测试：导出清单的结构性输入（实例扫描、文件名清洗、字节格式化）
 * 与导出前的参数校验。
 *
 * 真正的 zip 打包走系统 tar.exe（要 spawn 子进程），不放进单测；
 * 这里确保"扫出来的文件、版本号、加载器"和"拒绝非法导出请求"这两部分是对的——
 * 清单里写错版本号会让别的启动器装错版本，属于真实事故。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const exporter = require('../modpack-export');

async function tempDir(t, prefix = 'mcdl-export-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFileWithDirs(file, content = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

// ---------------- 纯函数 ----------------

test('formatBytes：按 KB / MB / GB 分级，且不出现 0 KB', () => {
  assert.equal(exporter.formatBytes(0), '1 KB');
  assert.equal(exporter.formatBytes(2048), '2 KB');
  assert.equal(exporter.formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(exporter.formatBytes(1536 * 1024), '1.5 MB');
  assert.equal(exporter.formatBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(exporter.formatBytes('abc'), '1 KB');
});

test('sanitizeFileName：剔除 Windows 非法字符并折叠空白', () => {
  assert.equal(exporter.sanitizeFileName('我的 整合包 v1.0'), '我的 整合包 v1.0');
  assert.equal(exporter.sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(exporter.sanitizeFileName('tab\there'), 'tab here');
  assert.equal(exporter.sanitizeFileName('  前后有空格  '), '前后有空格');
});

test('sanitizeFileName：空名字回落到 modpack，超长截到 80', () => {
  assert.equal(exporter.sanitizeFileName(''), 'modpack');
  assert.equal(exporter.sanitizeFileName('   '), 'modpack');
  assert.equal(exporter.sanitizeFileName(null), 'modpack');
  assert.equal(exporter.sanitizeFileName('x'.repeat(200)).length, 80);
});

test('CATEGORY_DEFS：默认勾选策略与分类键保持稳定', () => {
  const byKey = Object.fromEntries(exporter.CATEGORY_DEFS.map((def) => [def.key, def]));
  assert.deepEqual(Object.keys(byKey), [
    'mods', 'config', 'resourcepacks', 'shaderpacks', 'saves', 'schematics', 'options'
  ]);
  assert.equal(byKey.mods.defaultOn, true);
  assert.equal(byKey.config.defaultOn, true);
  assert.equal(byKey.saves.defaultOn, false, '存档体积大且涉及隐私，默认不导出');
  assert.deepEqual(byKey.options.files, ['options.txt', 'optionsof.txt', 'iris.properties', 'servers.dat']);
});

// ---------------- 实例扫描 ----------------

async function makeInstance(t) {
  const root = await tempDir(t);
  const gameDir = path.join(root, 'game');
  const versionDir = path.join(gameDir, 'versions', 'fabric-loader-0.15.11-1.20.1');

  await writeFileWithDirs(path.join(gameDir, 'mods', 'a.jar'), 'aaaaa');
  await writeFileWithDirs(path.join(gameDir, 'mods', '我的 模组.jar'), 'bb');
  await writeFileWithDirs(path.join(gameDir, 'mods', '.hidden.jar'), 'ignored');
  await writeFileWithDirs(path.join(gameDir, 'config', 'a.cfg'), 'ccc');
  await writeFileWithDirs(path.join(gameDir, 'options.txt'), 'opt');
  await writeFileWithDirs(path.join(gameDir, 'saves', 'world', 'level.dat'), 'ld');
  await writeFileWithDirs(path.join(versionDir, 'fabric-loader-0.15.11-1.20.1.json'),
    JSON.stringify({ id: 'fabric-loader-0.15.11-1.20.1', inheritsFrom: '1.20.1' }));

  return { root, gameDir, versionDir };
}

test('scanInstance：扫出各分类文件、总数与默认勾选状态', async (t) => {
  const { gameDir, versionDir } = await makeInstance(t);
  const scan = await exporter.scanInstance({
    id: 'inst-1',
    displayName: '我的整合包',
    versionName: '不是版本号',
    path: versionDir,
    gameDir,
    modLoader: 'Fabric',
    modLoaderVersion: '0.15.11'
  });

  assert.equal(scan.instanceId, 'inst-1');
  assert.equal(scan.name, '我的整合包');
  assert.equal(scan.suggestedVersion, '1.0.0');

  const mods = scan.categories.find((category) => category.key === 'mods');
  assert.deepEqual(mods.files.map((file) => file.rel), ['mods/a.jar', 'mods/我的 模组.jar']);
  assert.equal(mods.total, 7);
  assert.equal(mods.defaultOn, true);

  // 以点开头的文件不导出
  assert.equal(mods.files.some((file) => file.rel.includes('.hidden')), false);

  const config = scan.categories.find((category) => category.key === 'config');
  assert.deepEqual(config.files.map((file) => file.rel), ['config/a.cfg']);

  const options = scan.categories.find((category) => category.key === 'options');
  assert.deepEqual(options.files.map((file) => file.rel), ['options.txt']);

  const saves = scan.categories.find((category) => category.key === 'saves');
  assert.deepEqual(saves.files.map((file) => file.rel), ['saves/world/level.dat']);
  assert.equal(saves.defaultOn, false);

  assert.equal(scan.totalFiles, 5);
  assert.equal(scan.totalBytes, 7 + 3 + 3 + 2);
});

test('scanInstance：加载器名称映射成 CurseForge / Modrinth 的依赖键', async (t) => {
  const { gameDir, versionDir } = await makeInstance(t);

  const fabric = await exporter.scanInstance({ path: versionDir, gameDir, modLoader: 'Fabric', loaderLabel: 'Fabric' });
  assert.equal(fabric.loader, 'fabric-loader');

  const forge = await exporter.scanInstance({ path: versionDir, gameDir, loaderLabel: 'Forge' });
  assert.equal(forge.loader, 'forge');

  const neoforge = await exporter.scanInstance({ path: versionDir, gameDir, loaderLabel: 'NeoForge' });
  assert.equal(neoforge.loader, 'neoforge');

  const vanilla = await exporter.scanInstance({ path: versionDir, gameDir });
  assert.equal(vanilla.loader, '');
  assert.equal(vanilla.loaderLabel, 'Vanilla');
});

test('scanInstance：显示名不是版本号时从版本 JSON 里找出真实 Minecraft 版本', async (t) => {
  const { gameDir, versionDir } = await makeInstance(t);

  const scan = await exporter.scanInstance({
    id: 'inst-2',
    displayName: '某某整合包',
    versionName: '某某整合包 1.0',
    path: versionDir,
    gameDir
  });
  assert.equal(scan.versionName, '1.20.1');
});

test('scanInstance：versionName 本身就是合法版本号时直接采用', async (t) => {
  const { gameDir, versionDir } = await makeInstance(t);

  const scan = await exporter.scanInstance({ path: versionDir, gameDir, versionName: '1.21.1' });
  assert.equal(scan.versionName, '1.21.1');
});

test('scanInstance：目录不存在时返回空分类而不是抛错', async (t) => {
  const root = await tempDir(t);
  const scan = await exporter.scanInstance({
    id: 'inst-3',
    path: path.join(root, 'nope'),
    gameDir: path.join(root, 'nope-game')
  });

  assert.equal(scan.totalFiles, 0);
  assert.equal(scan.categories.length, exporter.CATEGORY_DEFS.length);
  assert.ok(scan.categories.every((category) => category.files.length === 0));
});

// ---------------- 导出参数校验 ----------------

test('exportPack：缺少扫描结果时拒绝', async (t) => {
  const root = await tempDir(t);
  await assert.rejects(
    exporter.exportPack({ targetFile: path.join(root, 'out.zip') }),
    /缺少实例扫描结果/
  );
});

test('exportPack：导出文件必须是 zip', async (t) => {
  const root = await tempDir(t);
  const scan = { categories: [], name: 'x', totalFiles: 0, versionName: '1.20.1' };

  await assert.rejects(
    exporter.exportPack({ scan, targetFile: path.join(root, 'out.tar') }),
    /必须是 \.zip/
  );
});

test('exportPack：没有勾选任何含文件的目录时拒绝（不产生临时目录）', async (t) => {
  const root = await tempDir(t);
  const scan = {
    categories: [{ key: 'mods', label: '模组', defaultOn: true, files: [], total: 0 }],
    name: 'x',
    totalFiles: 0,
    versionName: '1.20.1'
  };

  await assert.rejects(
    exporter.exportPack({ scan, targetFile: path.join(root, 'out.zip'), selection: [] }),
    /至少勾选一个包含文件的文件夹/
  );
  await assert.rejects(
    exporter.exportPack({ scan, targetFile: path.join(root, 'out.zip'), selection: ['mods'] }),
    /至少勾选一个包含文件的文件夹/
  );

  // 校验失败不应留下 .mcdl-export-* 工作目录
  const left = (await fs.readdir(root)).filter((name) => name.startsWith('.mcdl-export-'));
  assert.deepEqual(left, []);
});
