'use strict';

/**
 * 启动前完整性闸门测试。
 *
 * 锁住的是「失败路径」本身：缺库 / 缺 natives / 文件被截断 / 哈希不符，
 * 必须在 spawn 之前显式中止，并给出结构化的缺失清单；
 * 修复动作要能按清单重新下载，且失败时不能留下半个文件。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const preflight = require('../launch-preflight');
const launcher = require('../launch');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-preflight-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

/**
 * 造一个最小可启动实例：
 *   .minecraft/versions/<id>/{<id>.json,<id>.jar}
 *   .minecraft/assets/indexes/<id>.json
 *   .minecraft/libraries/<artifact>
 * 传入 libraryFile: false 时不写库文件（模拟安装中断 / 用户手删）。
 */
async function makeInstance(t, options = {}) {
  const root = await tempDir(t);
  const id = options.id || '1.20.4';
  const versionDir = path.join(root, 'versions', id);
  const librariesDir = path.join(root, 'libraries');

  const clientJar = Buffer.from('client-jar-bytes');
  const libraryFile = Buffer.from('library-bytes');
  const relatives = {
    artifact: 'com/example/core/1.0/core-1.0.jar',
    native: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar'
  };

  const manifest = {
    id,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: id,
    assetIndex: { id, sha1: sha1(Buffer.from('{}')), size: 2 },
    javaVersion: { majorVersion: 17 },
    libraries: [
      {
        name: 'com.example:core:1.0',
        downloads: {
          artifact: {
            path: relatives.artifact,
            url: 'http://127.0.0.1:9/core.jar',
            sha1: sha1(libraryFile),
            size: libraryFile.length
          }
        }
      }
    ],
    arguments: { game: ['--gameDir', '${game_directory}'], jvm: [] }
  };

  await write(path.join(versionDir, `${id}.json`), JSON.stringify(manifest));
  await write(path.join(versionDir, `${id}.jar`), clientJar);
  await write(path.join(root, 'assets', 'indexes', `${id}.json`), '{}');
  if (options.libraryFile !== false) {
    await write(path.join(librariesDir, relatives.artifact), libraryFile);
  }

  return { root, id, versionDir, librariesDir, relatives, clientJar, libraryFile };
}

function baseOptions(instance, extra = {}) {
  return {
    gameDir: instance.root,
    instanceId: instance.id,
    account: { type: 'offline', name: 'Steve' },
    settings: {},
    resolveJava: async () => ({ path: path.join(instance.root, 'jdk', 'bin', 'java.exe'), major: 17 }),
    ...extra
  };
}

// ---------------- 清单结构 ----------------

test('buildLaunchPlan：产出闸门要用的必需文件清单（客户端 jar / 库 / 资源索引）', async (t) => {
  const instance = await makeInstance(t);
  const plan = await launcher.buildLaunchPlan(baseOptions(instance));

  const kinds = plan.requiredFiles.map((entry) => entry.kind);
  assert.ok(kinds.includes('client'), '清单里必须有客户端 jar');
  assert.ok(kinds.includes('library'), '清单里必须有依赖库');
  assert.ok(kinds.includes('assetsIndex'), '清单里必须有资源索引');

  const library = plan.requiredFiles.find((entry) => entry.kind === 'library');
  assert.equal(library.sha1, sha1(instance.libraryFile));
  assert.equal(library.size, instance.libraryFile.length);
  assert.ok(library.url, '带下载地址的库才能被「修复」');
});

// ---------------- 校验：缺什么就说什么 ----------------

test('闸门：依赖库缺失时失败，并指出缺的是哪个文件', async (t) => {
  const instance = await makeInstance(t, { libraryFile: false });
  const plan = await launcher.buildLaunchPlan(baseOptions(instance));

  const result = await launcher.verifyLaunchPlan(plan);
  assert.equal(result.ok, false);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].kind, 'library');
  assert.match(result.missing[0].relative, /core-1\.0\.jar/);
  assert.match(result.summary.message, /已中止启动/);
  assert.match(result.summary.message, /依赖库/);
  assert.match(result.summary.message, /core-1\.0\.jar/);
});

test('闸门：空文件（下载到一半）算损坏，不是「存在就通过」', async (t) => {
  const instance = await makeInstance(t);
  await write(path.join(instance.librariesDir, instance.relatives.artifact), '');

  const plan = await launcher.buildLaunchPlan(baseOptions(instance));
  const result = await launcher.verifyLaunchPlan(plan);

  assert.equal(result.ok, false);
  assert.equal(result.corrupt.length, 1);
  assert.equal(result.corrupt[0].reason, 'empty');
});

test('闸门：大小与版本 JSON 不一致时报「大小不符」并给出两个数', async (t) => {
  const instance = await makeInstance(t);
  await write(path.join(instance.librariesDir, instance.relatives.artifact), 'short');

  const plan = await launcher.buildLaunchPlan(baseOptions(instance));
  const result = await launcher.verifyLaunchPlan(plan);

  assert.equal(result.ok, false);
  assert.equal(result.corrupt[0].reason, 'size');
  assert.match(preflight.describeFailure(result.corrupt[0]), /期望 \d+ 字节，实际 5 字节/);
});

test('闸门：默认只哈希小文件，库里的大文件只查大小（启动速度）', async (t) => {
  const instance = await makeInstance(t);
  // 库内容换掉（大小不变、哈希不符）：auto 模式不应报错
  const file = path.join(instance.librariesDir, instance.relatives.artifact);
  await write(file, 'librarv-bytes');

  const plan = await launcher.buildLaunchPlan(baseOptions(instance));

  const auto = await launcher.verifyLaunchPlan(plan, { hashCheck: 'auto' });
  assert.equal(auto.ok, true, 'auto 模式下依赖库只查大小');

  const strict = await launcher.verifyLaunchPlan(plan, { hashCheck: true });
  assert.equal(strict.ok, false);
  assert.equal(strict.corrupt[0].reason, 'hash');
});

test('闸门：客户端 jar 在 auto 模式下也校验 SHA-1', async (t) => {
  const instance = await makeInstance(t);
  const jar = path.join(instance.versionDir, `${instance.id}.jar`);

  // 版本 JSON 里补上客户端 jar 的哈希
  const jsonFile = path.join(instance.versionDir, `${instance.id}.json`);
  const manifest = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
  manifest.downloads = { client: { sha1: sha1(instance.clientJar), size: instance.clientJar.length } };
  await write(jsonFile, JSON.stringify(manifest));

  // 同长度的不同内容：只查大小发现不了，必须靠哈希
  await write(jar, Buffer.from('client-jar-bytez'));

  const plan = await launcher.buildLaunchPlan(baseOptions(instance));
  const result = await launcher.verifyLaunchPlan(plan);

  assert.equal(result.ok, false);
  assert.equal(result.corrupt[0].kind, 'client');
  assert.equal(result.corrupt[0].reason, 'hash');
});

test('闸门：natives 包缺失时失败（以前只是 warning）', async (t) => {
  const instance = await makeInstance(t);
  const jsonFile = path.join(instance.versionDir, `${instance.id}.json`);
  const manifest = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
  manifest.libraries.push({
    name: 'org.lwjgl:lwjgl:3.3.1',
    natives: { windows: 'natives-windows' },
    downloads: {
      artifact: { path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar' },
      classifiers: {
        'natives-windows': { path: instance.relatives.native, sha1: 'a'.repeat(40), size: 10 }
      }
    }
  });
  await write(jsonFile, JSON.stringify(manifest));
  await write(path.join(instance.librariesDir, 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar'), 'lwjgl');

  const plan = await launcher.buildLaunchPlan(baseOptions(instance));
  const result = await launcher.verifyLaunchPlan(plan);

  assert.equal(result.ok, false);
  const native = result.missing.find((item) => item.kind === 'native');
  assert.ok(native, '缺失的 natives 包必须在 missing 里');
});

test('闸门：optional 的文件（log4j 配置）缺失不算失败', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-preflight-opt-'));
  try {
    const result = await preflight.verifyRequiredFiles([
      { path: path.join(dir, 'nope.xml'), kind: 'logConfig', optional: true }
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.optionalMissing.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('闸门：清单为空也拒绝（防止调用方绕过闸门）', async () => {
  await assert.rejects(launcher.verifyLaunchPlan({ requiredFiles: null }), /缺少必需文件清单/);
  await assert.rejects(launcher.verifyLaunchPlan(null), /缺少必需文件清单/);
});

// ---------------- 闸门必须先于 spawn ----------------

test('launchInstance：缺库时抛 LAUNCH_PREFLIGHT_FAILED，根本没走到 spawn', async (t) => {
  const instance = await makeInstance(t, { libraryFile: false });

  const events = [];
  const error = await launcher.launchInstance(baseOptions(instance, {
    onEvent: (kind, payload) => events.push({ kind, payload })
  })).then(
    () => null,
    (rejected) => rejected
  );

  assert.ok(error, '必须 reject');
  assert.equal(error.code, 'LAUNCH_PREFLIGHT_FAILED');
  assert.equal(error.details.count, 1);
  assert.equal(error.details.failures[0].kind, 'library');
  // 关键：没有任何 spawned / output 事件 —— Java 没被拉起来
  const kinds = events.map((event) => event.kind);
  assert.ok(!kinds.includes('spawned'), '不能 spawn');
  assert.ok(!kinds.includes('output'), '不能有游戏输出');
  assert.equal(kinds[kinds.length - 1], 'preflight-failed');
});

test('launchInstance：文件齐全时闸门放行（后面的失败一定不是缺文件）', async (t) => {
  const instance = await makeInstance(t);
  const events = [];

  const error = await launcher.launchInstance(baseOptions(instance, {
    onEvent: (kind) => events.push(kind)
  })).then(
    () => null,
    (rejected) => rejected
  );

  // 闸门通过后才会去校验 Java：这里的假 Java 没登记，所以一定会失败，
  // 但它不能是「缺文件」那条错误。
  assert.ok(error);
  assert.notEqual(error.code, 'LAUNCH_PREFLIGHT_FAILED');
  assert.ok(!events.includes('preflight-failed'), '文件齐全时不该发 preflight-failed');
});

// ---------------- 启动进度：只报真的发生了的步骤 ----------------

test('进度：buildLaunchPlan 按代码实际执行顺序报告每一步', async (t) => {
  const instance = await makeInstance(t);
  const stages = [];
  const plan = await launcher.buildLaunchPlan(baseOptions(instance, {
    onStage: (stage) => stages.push(stage)
  }));

  // 每一步都必须是「先 running，后 done/failed」，且顺序就是代码里的执行顺序。
  const order = [];
  for (const stage of stages) {
    if (stage.state === 'running') order.push(stage.stage);
  }
  assert.deepEqual(order, ['instance', 'java', 'libraries', 'assets']);

  // 这个版本没有 natives：不伪造 running，但仍然如实说明「没有需要解压的」。
  const nativesDone = stages.find((stage) => stage.stage === 'natives' && stage.state === 'done');
  assert.ok(nativesDone, '没有 natives 时也要有一条 done 说明');
  assert.match(nativesDone.detail, /没有需要解压的 natives/);

  // 每个进入的步骤都必须收尾（不留半截）。
  const started = new Set(order);
  for (const stage of started) {
    assert.ok(
      stages.some((item) => item.stage === stage && item.state === 'done'),
      `${stage} 必须有 done`
    );
  }

  // 细节必须是真数据：Java 主版本、依赖库数量、资源索引文件名
  const javaDone = stages.find((stage) => stage.stage === 'java' && stage.state === 'done');
  assert.match(javaDone.detail, /Java 17/);
  const librariesDone = stages.find((stage) => stage.stage === 'libraries' && stage.state === 'done');
  assert.match(librariesDone.detail, /1 个依赖库/);
  const assetsDone = stages.find((stage) => stage.stage === 'assets' && stage.state === 'done');
  assert.match(assetsDone.detail, /indexes\/1\.20\.4\.json/);

  // 没有第三方账号时，不应出现 authlib 这一步（没做的事不显示）
  assert.ok(!stages.some((stage) => stage.stage === 'authlib'));
  assert.ok(plan.requiredFiles.length > 0);
});

test('进度：离线账号走完五步后，闸门与 spawn 由 launchInstance 报告', async (t) => {
  const instance = await makeInstance(t);
  const stages = [];

  await launcher.launchInstance(baseOptions(instance, {
    onEvent: (kind, payload) => {
      if (kind === 'stage') stages.push(payload);
    }
  })).catch(() => {});

  const verifyRunning = stages.find((stage) => stage.stage === 'verify' && stage.state === 'running');
  assert.ok(verifyRunning, '闸门必须有 running 状态');
  assert.match(verifyRunning.detail, /检查 \d+ 项必需文件/);

  // 文件齐全 → verify done，detail 里要说明校验强度（这是「验证了什么」的实证）。
  // 这个 fixture 里依赖库带了 sha1，所以必须出现「比对 SHA-1」这一句。
  const verifyDone = stages.find((stage) => stage.stage === 'verify' && stage.state === 'done');
  assert.ok(verifyDone);
  assert.match(verifyDone.detail, /检查 3 项/);
  assert.match(verifyDone.detail, /1 项比对 SHA-1/);
  assert.match(verifyDone.detail, /2 项检查存在与大小/);

  // 假 Java 没登记 → 不会走到 spawn
  assert.ok(!stages.some((stage) => stage.stage === 'spawn'));
});

test('进度：闸门失败时 verify 标为 failed，且没有 spawn 阶段', async (t) => {
  const instance = await makeInstance(t, { libraryFile: false });
  const stages = [];

  await launcher.launchInstance(baseOptions(instance, {
    onEvent: (kind, payload) => {
      if (kind === 'stage') stages.push(payload);
    }
  })).catch(() => {});

  const verifyFailed = stages.find((stage) => stage.stage === 'verify' && stage.state === 'failed');
  assert.ok(verifyFailed, '缺文件时 verify 必须是 failed');
  assert.match(verifyFailed.detail, /缺失或不一致/);
  assert.ok(!stages.some((stage) => stage.stage === 'spawn'), '失败后不能进 spawn');
});

test('取消：signal 已 aborted 时不 spawn，抛 LAUNCH_CANCELLED', async (t) => {
  const instance = await makeInstance(t);
  const controller = new AbortController();
  controller.abort();

  const events = [];
  const error = await launcher.launchInstance(baseOptions(instance, {
    signal: controller.signal,
    onEvent: (kind) => events.push(kind)
  })).then(
    () => null,
    (rejected) => rejected
  );

  assert.ok(error);
  assert.equal(error.code, 'LAUNCH_CANCELLED');
  assert.ok(!events.includes('spawned'));
  assert.ok(events.includes('begin'), '取消前应已发出 begin（渲染层据此显示进度窗口）');
});

// ---------------- 修复 ----------------

function startServer(t, routes) {
  const server = http.createServer((request, response) => {
    const route = routes[request.url];
    if (!route) {
      response.writeHead(404).end('no');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(route);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

test('修复：按清单重新下载缺失的库，校验通过后落到正确路径', async (t) => {
  const payload = Buffer.from('downloaded-library');
  const base = await startServer(t, { '/core.jar': payload });

  const instance = await makeInstance(t, { libraryFile: false });
  const jsonFile = path.join(instance.versionDir, `${instance.id}.json`);
  const manifest = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
  manifest.libraries[0].downloads.artifact.url = `${base}/core.jar`;
  manifest.libraries[0].downloads.artifact.sha1 = sha1(payload);
  manifest.libraries[0].downloads.artifact.size = payload.length;
  await write(jsonFile, JSON.stringify(manifest));

  const plan = await launcher.buildLaunchPlan(baseOptions(instance));
  const outcome = await launcher.repairLaunchPlan(plan);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.repair.repaired.length, 1);
  assert.equal(outcome.repair.failed.length, 0);
  assert.equal(await fs.readFile(path.join(instance.librariesDir, instance.relatives.artifact), 'utf8'),
    payload.toString());
});

test('修复：下载内容哈希不符时失败，且不留下半个文件', async (t) => {
  const payload = Buffer.from('evil-content');
  const base = await startServer(t, { '/core.jar': payload });

  const instance = await makeInstance(t, { libraryFile: false });
  const jsonFile = path.join(instance.versionDir, `${instance.id}.json`);
  const manifest = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
  manifest.libraries[0].downloads.artifact.url = `${base}/core.jar`;
  manifest.libraries[0].downloads.artifact.sha1 = sha1(Buffer.from('expected'));
  manifest.libraries[0].downloads.artifact.size = payload.length;
  await write(jsonFile, JSON.stringify(manifest));

  const plan = await launcher.buildLaunchPlan(baseOptions(instance));
  const outcome = await launcher.repairLaunchPlan(plan);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.repair.failed.length, 1);
  assert.match(outcome.repair.failed[0].message, /SHA-1/);

  const target = path.join(instance.librariesDir, instance.relatives.artifact);
  await assert.rejects(fs.access(target), '校验失败的文件不能被留在目标路径');
  const leftovers = (await fs.readdir(path.dirname(target))).filter((name) => name.includes('mcdl-part'));
  assert.deepEqual(leftovers, [], '临时文件必须被清掉');
});

test('修复：没有下载地址的条目留在 skipped 里，不假装修好了', async (t) => {
  const instance = await makeInstance(t, { libraryFile: false });
  const plan = await launcher.buildLaunchPlan(baseOptions(instance));
  // 把 url 去掉，模拟整合包手工塞的 jar
  plan.requiredFiles = plan.requiredFiles.map((entry) =>
    entry.kind === 'library' ? { ...entry, url: '' } : entry
  );

  const outcome = await launcher.repairLaunchPlan(plan);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.repair.skipped.length, 1);
  assert.equal(outcome.repair.repaired.length, 0);
});
