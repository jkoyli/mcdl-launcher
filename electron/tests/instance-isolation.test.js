'use strict';

/**
 * 版本隔离回归测试。
 *
 * 背景：扫描到 PCL / HMCL 的实例后点「启动游戏」，进游戏一个 mod 都没有。
 * 根因是启动时把 --gameDir 写成了 .minecraft，而隔离实例的 mods / config /
 * saves 都在 .minecraft/versions/<id>/ 下。
 *
 * 这里锁住三件事：
 *   1. instance-layout 能按「实例目录里有没有游戏内容」判定隔离；
 *   2. instance-store 的内容目录 / 游戏目录与启动口径一致；
 *   3. buildLaunchPlan 的 --gameDir 用实例目录，而 assets / libraries /
 *      客户端 jar 仍从 .minecraft 解析。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const layout = require('../instance-layout');
const { createInstanceStore } = require('../instance-store');
const { buildLaunchPlan } = require('../launch');
const mcdl = require('../mcdl-service');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-isolation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(file, text = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

const INSTANCE_ID = 'Craft to Exile 2';

/**
 * 造一个「别的启动器隔离启动」的实例：
 *   .minecraft/versions/<id>/{<id>.json, <id>.jar, mods/*.jar, config/…, options.txt}
 *   .minecraft/{assets/indexes/<index>.json, libraries/}
 */
async function makeIsolatedInstance(t) {
  const root = await tempDir(t);
  const gameDir = path.join(root, '.minecraft');
  const versionDir = path.join(gameDir, 'versions', INSTANCE_ID);

  const manifest = {
    id: INSTANCE_ID,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '5',
    assetIndex: { id: '5' },
    javaVersion: { majorVersion: 17 },
    libraries: [],
    arguments: {
      game: ['--gameDir', '${game_directory}', '--assetsDir', '${assets_root}'],
      jvm: []
    }
  };

  await write(path.join(versionDir, `${INSTANCE_ID}.json`), JSON.stringify(manifest));
  await write(path.join(versionDir, `${INSTANCE_ID}.jar`), 'jar');
  await write(path.join(versionDir, 'mods', 'create.jar'), 'mod');
  await write(path.join(versionDir, 'config', 'create-common.toml'), 'cfg');
  await write(path.join(versionDir, 'options.txt'), 'fov:0.5');
  await write(path.join(gameDir, 'assets', 'indexes', '5.json'), '{}');

  return { root, gameDir, versionDir };
}

const fakeJava = (root) => async () => ({ path: path.join(root, 'jdk17', 'bin', 'java.exe'), major: 17 });
const account = { type: 'offline', name: 'Steve' };

// ---------------- instance-layout：判定规则 ----------------

test('layout：实例目录有 mods/config/options.txt 时判定为版本隔离', async (t) => {
  const { gameDir, versionDir } = await makeIsolatedInstance(t);
  assert.equal(await layout.hasIsolatedContent(versionDir), true);

  const resolved = await layout.resolveGameDir({ versionDir, gameDir });
  assert.equal(resolved.isolated, true);
  assert.equal(resolved.gameDir.toLowerCase(), versionDir.toLowerCase());
  assert.equal(resolved.baseDir.toLowerCase(), gameDir.toLowerCase());
});

test('layout：只有版本 json / jar / natives 的实例仍是全局布局', async (t) => {
  const { gameDir } = await makeIsolatedInstance(t);
  const versionDir = path.join(gameDir, 'versions', '1.20.1');
  await write(path.join(versionDir, '1.20.1.json'), '{}');
  await write(path.join(versionDir, '1.20.1.jar'), 'jar');
  await write(path.join(versionDir, 'natives', 'lwjgl.dll'), 'dll');

  const resolved = await layout.resolveGameDir({ versionDir, gameDir });
  assert.equal(resolved.isolated, false);
  assert.equal(resolved.gameDir.toLowerCase(), gameDir.toLowerCase());
});

test('layout：显式 isolated / global 覆盖自动判定', async (t) => {
  const { gameDir, versionDir } = await makeIsolatedInstance(t);

  const global = await layout.resolveGameDir({ versionDir, gameDir, isolationMode: 'global' });
  assert.equal(global.isolated, false);
  assert.equal(global.gameDir.toLowerCase(), gameDir.toLowerCase());

  const emptyVersion = path.join(gameDir, 'versions', 'empty');
  await fs.mkdir(emptyVersion, { recursive: true });
  const isolated = await layout.resolveGameDir({ versionDir: emptyVersion, gameDir, isolationMode: 'isolated' });
  assert.equal(isolated.isolated, true);
  assert.equal(isolated.gameDir.toLowerCase(), emptyVersion.toLowerCase());
});

test('layout：实例目录缺失时退回基础目录；两者都缺时报错', async (t) => {
  const { gameDir } = await makeIsolatedInstance(t);
  const missing = await layout.resolveGameDir({ versionDir: path.join(gameDir, 'versions', 'nope'), gameDir });
  assert.equal(missing.gameDir.toLowerCase(), gameDir.toLowerCase());

  await assert.rejects(layout.resolveGameDir({}), /实例路径不完整/);
});

// ---------------- instance-store：内容目录 / 游戏目录 ----------------

test('instance-store：隔离实例的 mods 目录解析到 versions/<id>/mods', async (t) => {
  const { root, gameDir, versionDir } = await makeIsolatedInstance(t);
  const store = createInstanceStore({ storeDir: path.join(root, 'data') });
  const instance = { path: versionDir, gameDir };

  assert.equal(
    (await store.resolveGameDir(instance)).toLowerCase(),
    versionDir.toLowerCase()
  );

  const mods = await store.folderFor(instance, 'mods');
  assert.equal(mods.toLowerCase(), path.join(versionDir, 'mods').toLowerCase());

  const listed = await store.listContent(instance, 'mods');
  assert.deepEqual(listed.entries.map((entry) => entry.name), ['create.jar']);
});

test('instance-store：全局实例（只有 .minecraft/mods）仍用基础目录', async (t) => {
  const { root, gameDir } = await makeIsolatedInstance(t);
  const versionDir = path.join(gameDir, 'versions', '1.20.1');
  await write(path.join(versionDir, '1.20.1.json'), '{}');
  await write(path.join(versionDir, '1.20.1.jar'), 'jar');
  await write(path.join(gameDir, 'mods', 'sodium.jar'), 'mod');

  const store = createInstanceStore({ storeDir: path.join(root, 'data') });
  const instance = { path: versionDir, gameDir };

  assert.equal((await store.resolveGameDir(instance)).toLowerCase(), gameDir.toLowerCase());
  const mods = await store.folderFor(instance, 'mods');
  assert.equal(mods.toLowerCase(), path.join(gameDir, 'mods').toLowerCase());
});

// ---------------- 启动计划：这就是用户看到的 bug ----------------

test('启动计划：隔离实例的 --gameDir 是实例目录，assets / 客户端 jar 仍来自 .minecraft', async (t) => {
  const { root, gameDir, versionDir } = await makeIsolatedInstance(t);
  const plan = await buildLaunchPlan({
    gameDir,
    instanceDir: versionDir,
    instanceId: INSTANCE_ID,
    account,
    settings: {},
    resolveJava: fakeJava(root)
  });

  assert.equal(plan.gameDir.toLowerCase(), versionDir.toLowerCase());
  assert.equal(plan.baseDir.toLowerCase(), gameDir.toLowerCase());
  assert.equal(plan.isolated, true);

  const index = plan.args.indexOf('--gameDir');
  assert.notEqual(index, -1, '启动参数里必须有 --gameDir');
  assert.equal(plan.args[index + 1].toLowerCase(), versionDir.toLowerCase());

  const assetsIndex = plan.args.indexOf('--assetsDir');
  assert.equal(plan.args[assetsIndex + 1].toLowerCase(), path.join(gameDir, 'assets').toLowerCase());

  assert.equal(
    plan.classpath[0].toLowerCase(),
    path.join(versionDir, `${INSTANCE_ID}.jar`).toLowerCase()
  );
});

test('启动计划：不传 instanceDir 时保持旧的全局行为', async (t) => {
  const { root, gameDir } = await makeIsolatedInstance(t);
  const plan = await buildLaunchPlan({
    gameDir,
    instanceId: INSTANCE_ID,
    account,
    settings: {},
    resolveJava: fakeJava(root)
  });

  assert.equal(plan.gameDir.toLowerCase(), gameDir.toLowerCase());
  assert.equal(plan.isolated, false);
  const index = plan.args.indexOf('--gameDir');
  assert.equal(plan.args[index + 1].toLowerCase(), gameDir.toLowerCase());
});

test('扫描 → 解析 → 启动：外部实例整条链路都用实例目录（回归）', async (t) => {
  const { root, gameDir, versionDir } = await makeIsolatedInstance(t);

  // 1. 扫描：模拟从 PCL/HMCL 目录扫到的实例
  const snapshot = await mcdl.scanInstances(gameDir, {}, { primary: true });
  const instance = snapshot.instances.find((item) => item.id === INSTANCE_ID);
  assert.ok(instance, '扫描应该找到这个实例');
  assert.equal(instance.gameDir.toLowerCase(), gameDir.toLowerCase());
  assert.equal(instance.path.toLowerCase(), versionDir.toLowerCase());

  // 2. 解析：实例实际游戏目录 = 版本隔离目录
  const store = createInstanceStore({ storeDir: path.join(root, 'data') });
  const instanceDir = await store.resolveGameDir(instance);
  assert.equal(instanceDir.toLowerCase(), versionDir.toLowerCase());

  // 3. 启动计划：--gameDir 必须是实例目录，否则 mods 一个都读不到
  const plan = await buildLaunchPlan({
    gameDir: instance.gameDir,
    instanceDir,
    instanceId: path.basename(instance.path),
    account,
    settings: {},
    resolveJava: fakeJava(root)
  });

  const index = plan.args.indexOf('--gameDir');
  assert.equal(plan.args[index + 1].toLowerCase(), versionDir.toLowerCase());
  assert.equal(plan.gameDir.toLowerCase(), instanceDir.toLowerCase());
});
