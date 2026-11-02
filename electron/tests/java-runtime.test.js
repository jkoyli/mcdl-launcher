'use strict';

/**
 * Java 选择测试：Mojang 规范里的「最低版本 + 合规上限」。
 *
 * 锁住的是一个真实 bug 的根因：1.16.5 及更早的 version.json 没有 javaVersion
 * 字段，旧实现把它当「没有要求」，于是从本机运行时里挑最新（比如 Java 21）去跑
 * 1.12.2 / 1.7.10 Forge 实例，游戏直接崩在
 * `Unsupported class file major version`。
 *
 * 这里同时覆盖：
 *   1. version-manifest 的 complianceLevel 合并（顶层 / javaVersion 内）；
 *   2. 需求推导（无 javaVersion → 8/8，major 16 → 16，major 17 → 17）；
 *   3. pickJava 的选择顺序、区间回落与 null；
 *   4. launch.buildLaunchPlan 真的把 compliance 传给了 Java 解析器，
 *      并拒绝「高于上限」的回落选择；
 *   5. 旧签名 pickJava(runtimes, number) 仍可用，64 位优先不变。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const javaRuntime = require('../java-runtime');
const manifest = require('../version-manifest');
const launcher = require('../launch');

function runtime(major, options = {}) {
  const bitness = options.bitness || 64;
  return {
    path: options.path || `C:\\jdk\\${major}${bitness === 32 ? '-x86' : ''}\\bin\\java.exe`,
    major,
    version: options.version || `${major}.0.1`,
    arch: bitness === 32 ? 'x86' : 'amd64',
    bitness,
    vendor: 'test'
  };
}

function pick(runtimes, requirement) {
  const picked = javaRuntime.pickJava(runtimes, requirement);
  return picked ? picked.major : null;
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-java-runtime-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

/**
 * 最小可构造的实例：只有版本 JSON / 客户端 jar / 资源索引，
 * 用来验证 buildLaunchPlan 把什么参数交给了 resolveJava。
 */
async function makeInstance(t, extraManifest = {}) {
  const root = await tempDir(t);
  const id = '1.12.2-forge';
  const versionDir = path.join(root, 'versions', id);
  const versionJson = {
    id,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: 'legacy',
    assetIndex: { id: 'legacy' },
    libraries: [],
    arguments: { game: ['--gameDir', '${game_directory}'], jvm: [] },
    ...extraManifest
  };

  await write(path.join(versionDir, `${id}.json`), JSON.stringify(versionJson));
  await write(path.join(versionDir, `${id}.jar`), 'jar');
  await write(path.join(root, 'assets', 'indexes', 'legacy.json'), '{}');

  return { root, id, versionDir, versionJson };
}

function planOptions(instance, resolveJava) {
  return {
    gameDir: instance.root,
    instanceId: instance.id,
    account: { type: 'offline', name: 'Steve' },
    settings: {},
    resolveJava
  };
}

// ---------------- 1. 无 javaVersion：必须选 8 ----------------

test('pickJava：1.12.2 那种没有 javaVersion 的 manifest 从 [8,17,21] 里选 8', () => {
  const requirement = manifest.javaRequirement({ javaVersion: null });
  assert.equal(requirement.required, 8);
  assert.equal(requirement.ceiling, 8);
  assert.equal(requirement.declared, false);

  assert.equal(pick([runtime(8), runtime(17), runtime(21)], requirement), 8);
});

test('buildLaunchPlan：无 javaVersion 时把 required=8 / ceiling=8 交给 Java 解析器', async (t) => {
  const instance = await makeInstance(t);
  const captured = [];
  const stages = [];

  const plan = await launcher.buildLaunchPlan({
    ...planOptions(instance, async (options) => {
      captured.push(options);
      return runtime(8, { path: path.join(instance.root, 'jdk8', 'bin', 'java.exe') });
    }),
    onStage: (stage) => stages.push(stage)
  });

  assert.ok(plan);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].requiredMajor, 8);
  assert.equal(captured[0].required, 8);
  assert.equal(captured[0].ceiling, 8);
  assert.equal(captured[0].versionId, instance.id);

  const running = stages.find((stage) => stage.stage === 'java' && stage.state === 'running');
  assert.match(running.detail, /没有声明 Java 版本要求/);
  assert.match(running.detail, /Java 8/);
});

// ---------------- 2. 1.16.5：major 8 + compliance 8 ----------------

test('pickJava：javaVersion.majorVersion=8 / complianceLevel=8（1.16.5）只选 8', () => {
  const chain = [{
    id: '1.16.5',
    manifest: { javaVersion: { component: 'jre', majorVersion: 8, complianceLevel: 8 } }
  }];
  const requirement = manifest.javaRequirement(manifest.mergeChain(chain));

  assert.equal(requirement.required, 8);
  assert.equal(requirement.ceiling, 8);
  assert.equal(pick([runtime(8), runtime(17), runtime(21)], requirement), 8);
});

// ---------------- 3/4. 1.17 用 16、1.20.1 用 17 ----------------

test('pickJava：majorVersion=16（1.17）选 16，而不是更低的 8', () => {
  const chain = [{ id: '1.17', manifest: { javaVersion: { majorVersion: 16 } } }];
  const requirement = manifest.javaRequirement(manifest.mergeChain(chain));

  assert.equal(requirement.required, 16);
  assert.equal(requirement.ceiling, null);
  assert.equal(pick([runtime(8), runtime(16), runtime(17), runtime(21)], requirement), 16);
});

test('pickJava：majorVersion=17（1.20.1）从 [8,17,21] 里选 17', () => {
  const chain = [{
    id: '1.20.1',
    manifest: { javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 } }
  }];
  const requirement = manifest.javaRequirement(manifest.mergeChain(chain));

  assert.equal(requirement.required, 17);
  assert.equal(requirement.ceiling, null);
  assert.equal(pick([runtime(8), runtime(17), runtime(21)], requirement), 17);
});

test('pickJava：现代官方 JSON 的顶层 complianceLevel=1 不会把 1.20.1 压回 Java 8', () => {
  // 真实 1.20.1.json：complianceLevel 是玩家安全合规级别（1），不是 Java 版本。
  const chain = [{
    id: '1.20.1',
    manifest: {
      complianceLevel: 1,
      javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 }
    }
  }];
  const merged = manifest.mergeChain(chain);
  const requirement = manifest.javaRequirement(merged);

  assert.equal(merged.complianceLevel, 1);
  assert.equal(requirement.required, 17);
  assert.equal(requirement.ceiling, null);
  assert.equal(pick([runtime(8), runtime(17), runtime(21)], requirement), 17);
});

// ---------------- 5. 区间回落 / null ----------------

test('pickJava：区间内没有精确版本时回落到「>= required 的最小值」', () => {
  // 11 只做上限示例：区间 [11,11] 内没有，回落 17（而不是 21，也不是 8）。
  assert.equal(pick([runtime(8), runtime(17), runtime(21)], { required: 11, ceiling: 11 }), 17);
});

test('pickJava：只有更低版本时回落逻辑依旧取 >= required 的最小值', () => {
  // required=8 / ceiling=8，但本机没有 8：按接口约定回落到 17，由 launch 层拒绝。
  assert.equal(pick([runtime(17), runtime(21)], { required: 8, ceiling: 8 }), 17);
});

test('pickJava：本机没有 >= required 的版本时返回 null（不再硬塞最高版本）', () => {
  assert.equal(javaRuntime.pickJava([runtime(8), runtime(17)], { required: 21, ceiling: null }), null);
  assert.equal(javaRuntime.pickJava([runtime(8)], 21), null);
  assert.equal(javaRuntime.pickJava([], 17), null);
  assert.equal(javaRuntime.pickJava(null, 17), null);
});

test('buildLaunchPlan：只能选到高于上限的 Java 时在 spawn 前中止，并提示所需区间', async (t) => {
  const instance = await makeInstance(t);

  await assert.rejects(
    launcher.buildLaunchPlan(planOptions(instance, async () => runtime(17))),
    /该版本需要 Java 8，但本机没有找到匹配的运行时[\s\S]*class 文件版本不兼容/
  );
});

// ---------------- 6. complianceLevel 合并 ----------------

test('mergeChain：父有顶层 complianceLevel、子没有 → 继承父', () => {
  const chain = [
    { id: '1.16.5', manifest: { complianceLevel: 1 } },
    { id: '1.16.5-forge', manifest: { inheritsFrom: '1.16.5' } }
  ];
  assert.equal(manifest.mergeChain(chain).complianceLevel, 1);
});

test('mergeChain：子有顶层 complianceLevel、父没有 → 用子', () => {
  const chain = [
    { id: '1.12.2', manifest: {} },
    { id: '1.12.2-forge', manifest: { complianceLevel: 3 } }
  ];
  assert.equal(manifest.mergeChain(chain).complianceLevel, 3);
});

test('mergeChain：父子都有顶层 complianceLevel → 子覆盖父', () => {
  const chain = [
    { id: '1.12.2', manifest: { complianceLevel: 1 } },
    { id: '1.12.2-forge', manifest: { complianceLevel: 3 } }
  ];
  assert.equal(manifest.mergeChain(chain).complianceLevel, 3);
});

test('mergeChain：javaVersion 里的 complianceLevel 随 javaVersion 一起保留', () => {
  const chain = [
    { id: '1.16.5', manifest: { javaVersion: { majorVersion: 8, complianceLevel: 8 } } },
    { id: '1.16.5-forge', manifest: { inheritsFrom: '1.16.5' } }
  ];
  const merged = manifest.mergeChain(chain);
  assert.equal(merged.javaVersion.majorVersion, 8);
  assert.equal(merged.javaVersion.complianceLevel, 8);

  const requirement = manifest.javaRequirement(merged);
  assert.equal(requirement.complianceLevel, 8);
  assert.equal(requirement.ceiling, 8);
});

test('javaRequirement：没有 javaVersion / complianceLevel 的实例按 8~8 处理', () => {
  const requirement = manifest.javaRequirement(manifest.mergeChain([
    { id: '1.7.10-forge', manifest: { inheritsFrom: null } }
  ]));
  assert.deepEqual(
    { required: requirement.required, ceiling: requirement.ceiling, declared: requirement.declared },
    { required: 8, ceiling: 8, declared: false }
  );
});

// ---------------- 7. 64 位优先 / 旧签名 ----------------

test('pickJava：同主版本下 64 位优先不被破坏', () => {
  const runtimes = [runtime(8, { bitness: 32 }), runtime(8, { bitness: 64 })];
  const picked = javaRuntime.pickJava(runtimes, { required: 8, ceiling: 8 });
  assert.equal(picked.bitness, 64);
  // 32 位排在数组前面也不能被选中
  assert.equal(picked.path, runtimes[1].path);
});

test('pickJava：旧签名 pickJava(runtimes, number) 仍然工作', () => {
  assert.equal(pick([runtime(8), runtime(17), runtime(21)], 17), 17);
  assert.equal(pick([runtime(8), runtime(17), runtime(21)], 8), 8);
  // 旧签名 required=0 表示「没有版本要求」：保持旧行为返回最高版本
  assert.equal(pick([runtime(8), runtime(17), runtime(21)], 0), 21);
});

test('pickJava：第三种写法 pickJava(runtimes, required, ceiling) 与对象写法等价', () => {
  const runtimes = [runtime(8), runtime(16), runtime(17), runtime(21)];
  assert.equal(pick(runtimes, 8, 8), 8);
  assert.equal(pick(runtimes, 16, null), 16);
  assert.equal(javaRuntime.pickJava(runtimes, { required: 16, ceiling: 16 }).major, 16);
});

test('normalizeJavaRequirement：required <= 8 自动封顶 8，required >= 9 不设上限', () => {
  assert.deepEqual(javaRuntime.normalizeJavaRequirement(8), { required: 8, ceiling: 8 });
  assert.deepEqual(javaRuntime.normalizeJavaRequirement(7), { required: 7, ceiling: 8 });
  assert.deepEqual(javaRuntime.normalizeJavaRequirement(17), { required: 17, ceiling: null });
  assert.deepEqual(
    javaRuntime.normalizeJavaRequirement({ required: 17, ceiling: 21 }),
    { required: 17, ceiling: 21 }
  );
});
