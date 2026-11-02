'use strict';

/**
 * launch-spec 测试：唯一能产出「可执行文件 + 参数」的地方。
 *
 * 这层守的是"随便一个字符串不能变成 spawn 的目标"：
 *   - 可执行文件必须是本机绝对路径，且文件名只能是 java / javaw；
 *   - 参数必须是字符串数组，不能混进数字、对象或 NUL；
 *   - 产出物冻结，检查完就改不动。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const spec = require('../launch-spec');

const IS_WINDOWS = process.platform === 'win32';
const JAVA = IS_WINDOWS ? 'java.exe' : 'java';
const JAVAW = IS_WINDOWS ? 'javaw.exe' : 'javaw';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-launch-spec-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeJava(t, name = JAVA, content = 'x') {
  const dir = await tempDir(t);
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return { dir, file };
}

// ---------------- 可执行文件形状 ----------------

test('assertJavaExecutableShape：合法 java 可执行文件返回规范化路径', async (t) => {
  const { file } = await makeJava(t);
  const resolved = await spec.assertJavaExecutableShape(file);
  assert.equal(resolved.toLowerCase(), path.resolve(file).toLowerCase());
});

test('assertJavaExecutableShape：文件名不是 java / javaw 时拒绝（防止任意 exe 被启动）', async (t) => {
  const { file } = await makeJava(t, IS_WINDOWS ? 'evil.exe' : 'evil', 'MZ');
  await assert.rejects(spec.assertJavaExecutableShape(file), /必须指向/);

  const { file: cmd } = await makeJava(t, IS_WINDOWS ? 'cmd.exe' : 'sh');
  await assert.rejects(spec.assertJavaExecutableShape(cmd), /必须指向/);
});

test('assertJavaExecutableShape：路径不存在或是目录时拒绝', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(
    spec.assertJavaExecutableShape(path.join(dir, JAVA)),
    /不存在或不是文件/
  );

  // 目录就算叫 java.exe 也不行
  const fake = path.join(dir, JAVA);
  await fs.mkdir(fake);
  await assert.rejects(spec.assertJavaExecutableShape(fake), /不存在或不是文件/);
});

test('assertJavaExecutableShape：相对路径与 UNC 路径都拒绝', async (t) => {
  const { file } = await makeJava(t);
  await assert.rejects(spec.assertJavaExecutableShape(path.relative(process.cwd(), file)), /必须是完整路径/);
  await assert.rejects(spec.assertJavaExecutableShape('\\\\attacker\\share\\java.exe'), /网络路径或设备路径/);
  await assert.rejects(spec.assertJavaExecutableShape(''), /不能为空/);
});

test('resolveJavaExecutable：java.exe 存在同目录 javaw.exe 时改用 javaw（不弹控制台）', async (t) => {
  if (!IS_WINDOWS) {
    t.skip('仅在 Windows 上存在 java.exe → javaw.exe 的替换逻辑');
    return;
  }

  const { dir, file } = await makeJava(t, 'java.exe');
  await fs.writeFile(path.join(dir, 'javaw.exe'), 'x');

  const resolved = await spec.resolveJavaExecutable(file);
  assert.equal(resolved.toLowerCase(), path.join(dir, 'javaw.exe').toLowerCase());
});

test('resolveJavaExecutable：javaw.exe 缺失时继续用 java.exe（不再无条件改名）', async (t) => {
  if (!IS_WINDOWS) {
    t.skip('仅在 Windows 上存在 java.exe → javaw.exe 的替换逻辑');
    return;
  }

  const { file } = await makeJava(t, 'java.exe');
  const resolved = await spec.resolveJavaExecutable(file);
  assert.equal(resolved.toLowerCase(), path.resolve(file).toLowerCase());
});

// ---------------- 启动规格 ----------------

test('createLaunchSpec：产出可执行文件、参数与游戏目录', async (t) => {
  const { dir, file } = await makeJava(t);
  const gameDir = path.join(dir, 'game');

  const plan = await spec.createLaunchSpec({
    javaPath: file,
    args: ['-Xmx2G', '-cp', 'a.jar;b.jar', 'net.minecraft.client.main.Main'],
    gameDir
  });

  assert.equal(plan.executable.toLowerCase(), path.resolve(file).toLowerCase());
  assert.deepEqual(plan.args, ['-Xmx2G', '-cp', 'a.jar;b.jar', 'net.minecraft.client.main.Main']);
  assert.equal(plan.gameDir, path.resolve(gameDir));
});

test('createLaunchSpec：产出物冻结，调用方检查后改不动', async (t) => {
  const { dir, file } = await makeJava(t);
  const args = ['-Xmx2G', '-cp', 'a.jar'];
  const gameDir = path.join(dir, 'game');

  const plan = await spec.createLaunchSpec({ javaPath: file, args, gameDir });

  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.args), true);

  // 事后改原始数组不会影响已经产出的规格
  args.push('-Dlate.injection=1');
  args[0] = '-Xmx64G';
  assert.deepEqual(plan.args, ['-Xmx2G', '-cp', 'a.jar']);

  // 冻结对象上的写入静默失败（非严格模式）或抛错（严格模式），两种都视为"改不动"
  try {
    plan.executable = 'C:\\Windows\\System32\\cmd.exe';
  } catch {
    /* 严格模式下抛 TypeError，符合预期 */
  }
  assert.equal(plan.executable.toLowerCase(), path.resolve(file).toLowerCase());
});

test('createLaunchSpec：参数必须是字符串数组', async (t) => {
  const { dir, file } = await makeJava(t);
  const gameDir = path.join(dir, 'game');

  await assert.rejects(
    spec.createLaunchSpec({ javaPath: file, args: '-Xmx2G', gameDir }),
    /启动参数必须是数组/
  );
  await assert.rejects(
    spec.createLaunchSpec({ javaPath: file, args: ['-Xmx2G', 42], gameDir }),
    /启动参数只能是字符串/
  );
  await assert.rejects(
    spec.createLaunchSpec({ javaPath: file, args: [null], gameDir }),
    /启动参数只能是字符串/
  );
  await assert.rejects(
    spec.createLaunchSpec({ javaPath: file, args: [{ toString: () => '-Xmx2G' }], gameDir }),
    /启动参数只能是字符串/
  );
  await assert.rejects(
    spec.createLaunchSpec({ javaPath: file, args: ['-Dname=a\0b'], gameDir }),
    /启动参数含有非法字符/
  );
});

test('createLaunchSpec：游戏目录必须是本机绝对路径', async (t) => {
  const { file } = await makeJava(t);

  await assert.rejects(
    spec.createLaunchSpec({ javaPath: file, args: [], gameDir: 'game' }),
    /必须是完整路径/
  );
  await assert.rejects(
    spec.createLaunchSpec({ javaPath: file, args: [], gameDir: '\\\\attacker\\share\\game' }),
    /网络路径或设备路径/
  );
  await assert.rejects(
    spec.createLaunchSpec({ javaPath: file, args: [], gameDir: '' }),
    /不能为空/
  );
});

test('createLaunchSpec：空参数数组合法（只需形状正确）', async (t) => {
  const { dir, file } = await makeJava(t);
  const plan = await spec.createLaunchSpec({ javaPath: file, args: [], gameDir: dir });
  assert.deepEqual(plan.args, []);
});

test('createLaunchSpec：启动计划形状不对时拒绝', async () => {
  await assert.rejects(spec.createLaunchSpec(), /启动计划无效/);
  await assert.rejects(spec.createLaunchSpec(null), /启动计划无效/);
  await assert.rejects(spec.createLaunchSpec('x'), /启动计划无效/);
});

test('createLaunchSpec：assertJava 授权校验先于一切文件检查执行', async (t) => {
  const dir = await tempDir(t);
  const calls = [];

  // javaPath 根本不存在，但授权校验先抛错——证明绕不过授权表
  await assert.rejects(
    spec.createLaunchSpec(
      { javaPath: path.join(dir, 'java.exe'), args: [], gameDir: dir },
      {
        assertJava: async (javaPath) => {
          calls.push(javaPath);
          throw new Error('这个 Java 没有授权');
        }
      }
    ),
    /没有授权/
  );

  assert.equal(calls.length, 1, 'assertJava 必须被调用一次');
  assert.equal(calls[0], path.join(dir, 'java.exe'));
});
