'use strict';

/**
 * 打包运行时解析测试。
 *
 * 锁住三件在真机上会翻车的事：
 *   1. mcdl.jar 的位置不能依赖「__dirname 恰好等于 app.asar 根」这种巧合；
 *   2. mcdl 的 cwd 不能是安装目录（Program Files 只读 → EACCES）；
 *   3. 用户机器没装 Java 时，必须能落到内置 JRE（或给出 ENOJAVA 可读错误），
 *      而不是把 spawn 的 ENOENT 冒到渲染层。
 *
 * mcdl-service / java-runtime 都刻意不 require('electron')，所以这些用例
 * 在纯 node 下就能跑，不需要打包产物。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const mcdl = require('../mcdl-service');
const javaRuntime = require('../java-runtime');

const DEV_JAR = path.join(__dirname, '..', '..', 'mcdl', 'mcdl.jar');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-bundled-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFileWithDirs(file, content = '') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

/** 暂时清掉 MCDL_JAR，避免开发机上的环境变量影响断言。 */
function withoutJarEnv(t) {
  const saved = process.env.MCDL_JAR;
  delete process.env.MCDL_JAR;
  t.after(() => {
    if (saved === undefined) delete process.env.MCDL_JAR;
    else process.env.MCDL_JAR = saved;
  });
}

test('resolveMcdlJar：开发态用 electron/../mcdl/mcdl.jar', (t) => {
  withoutJarEnv(t);
  assert.equal(mcdl.resolveMcdlJar({ isPackaged: false }), DEV_JAR);
});

test('resolveMcdlJar：打包态用 <resources>/mcdl/mcdl.jar', async (t) => {
  withoutJarEnv(t);
  const resources = await tempDir(t);
  assert.equal(
    mcdl.resolveMcdlJar({ isPackaged: true, resourcesPath: resources }),
    path.join(resources, 'mcdl', 'mcdl.jar')
  );
});

test('resolveMcdlJar：MCDL_JAR 环境变量优先级最高', async (t) => {
  const resources = await tempDir(t);
  const custom = path.join(resources, 'custom', 'my-mcdl.jar');
  const saved = process.env.MCDL_JAR;
  process.env.MCDL_JAR = custom;
  t.after(() => {
    if (saved === undefined) delete process.env.MCDL_JAR;
    else process.env.MCDL_JAR = saved;
  });

  assert.equal(mcdl.resolveMcdlJar({ isPackaged: true, resourcesPath: resources }), custom);
});

test('configure 注入的打包信息会被 resolveMcdlJar 使用（纯 node 下）', async (t) => {
  withoutJarEnv(t);
  const resources = await tempDir(t);
  mcdl.configure({ isPackaged: true, resourcesPath: resources });
  t.after(() => mcdl.configure({ isPackaged: false, resourcesPath: '' }));

  assert.equal(mcdl.resolveMcdlJar(), path.join(resources, 'mcdl', 'mcdl.jar'));
  // 旧的 MCDL_JAR 视图也跟随配置（main.js 的启动日志用它）。
  assert.equal(mcdl.MCDL_JAR, path.join(resources, 'mcdl', 'mcdl.jar'));
});

test('jar 不存在时给出可读错误（ENOJAR + 中文提示）', async (t) => {
  const missing = path.join(await tempDir(t), 'nope', 'mcdl.jar');
  await assert.rejects(
    () => mcdl.assertMcdlJar(missing),
    (error) => {
      assert.equal(error.code, 'ENOJAR');
      assert.match(error.message, /找不到 mcdl\.jar/);
      assert.match(error.message, /安装包可能不完整/);
      return true;
    }
  );
});

test('jar 存在时 assertMcdlJar 返回绝对路径', async (t) => {
  const jar = path.join(await tempDir(t), 'mcdl', 'mcdl.jar');
  await writeFileWithDirs(jar, 'not-a-real-jar');
  assert.equal(await mcdl.assertMcdlJar(jar), path.resolve(jar));
});

test('resolveWorkDir：使用可写的 userData 而不是只读的 jar 目录', async (t) => {
  const userData = await tempDir(t);
  const roJarDir = path.join(await tempDir(t), 'resources', 'mcdl');
  await fs.mkdir(roJarDir, { recursive: true });

  mcdl.configure({ userData });
  t.after(() => mcdl.configure({ userData: '' }));

  const workDir = await mcdl.resolveWorkDir(path.join(roJarDir, 'mcdl.jar'));
  assert.equal(workDir, path.join(userData, 'mcdl'));
  // 探针文件必须已删除，cwd 里不能留垃圾。
  assert.deepEqual(await fs.readdir(workDir), []);
});

test('bundledJava：没有 JRE 时返回 null（README 占位目录不算）', async (t) => {
  const resources = await tempDir(t);
  const devRoot = await tempDir(t);
  // 占位目录：只有 README.txt
  await writeFileWithDirs(path.join(resources, 'jre', 'README.txt'), 'placeholder');

  assert.equal(javaRuntime.bundledJava({ resourcesPath: resources, devRoot }), null);
});

test('bundledJava：伪造出 jre/bin/java.exe 后返回该路径', async (t) => {
  const resources = await tempDir(t);
  const javaPath = path.join(resources, 'jre', 'bin', javaRuntime.JAVA_EXE);
  await writeFileWithDirs(javaPath, '');

  assert.equal(
    javaRuntime.bundledJava({ resourcesPath: resources, devRoot: path.join(resources, 'empty') }),
    path.resolve(javaPath)
  );
});

test('bundledJava：开发态认 electron/jre/bin/java.exe', async (t) => {
  const devRoot = await tempDir(t);
  const javaPath = path.join(devRoot, 'jre', 'bin', javaRuntime.JAVA_EXE);
  await writeFileWithDirs(javaPath, '');

  assert.equal(
    javaRuntime.bundledJava({ resourcesPath: path.join(devRoot, 'no-resources'), devRoot }),
    path.resolve(javaPath)
  );
});

test('findJavaForTools：显式候选为空时返回 null', async () => {
  assert.equal(await javaRuntime.findJavaForTools({ candidates: [] }), null);
});

test('完全没有 Java 时抛 ENOJAVA，并提示「设置 → Java 管理 → 安装 Java」', async () => {
  await assert.rejects(
    () => mcdl.resolveJavaBinary({ force: true, candidates: [] }),
    (error) => {
      assert.equal(error.code, 'ENOJAVA');
      assert.match(error.message, /没有可用的 Java/);
      assert.match(error.message, /安装 Java/);
      return true;
    }
  );
});

test('findJavaForTools：显式候选里有 java 时直接返回它', async (t) => {
  const fake = path.join(await tempDir(t), 'jdk', 'bin', javaRuntime.JAVA_EXE);
  await writeFileWithDirs(fake, '');

  assert.equal(await javaRuntime.findJavaForTools({ candidates: [fake] }), path.resolve(fake));
});

// 回归：mcdl.jar 由 JDK 17 编译，用 Java 8 去跑会在 checkAndLoadMain 处
// 报「主类加载失败」，界面上只看到「无法读取版本列表」。
test('findJavaForTools：缓存里 Java 8 排在前面时不能被选中', async (t) => {
  const root = await tempDir(t);
  const j8 = path.join(root, 'jre8', 'bin', javaRuntime.JAVA_EXE);
  const j17 = path.join(root, 'jdk17', 'bin', javaRuntime.JAVA_EXE);
  await writeFileWithDirs(j8, '');
  await writeFileWithDirs(j17, '');

  const picked = await javaRuntime.findJavaForTools({
    cache: [
      { path: j8, major: 8 },
      { path: j17, major: 17 }
    ]
  });
  assert.equal(picked, path.resolve(j17));
});

test('findJavaForTools：多个合格版本时取主版本最高的', async (t) => {
  const root = await tempDir(t);
  const j17 = path.join(root, 'a', 'bin', javaRuntime.JAVA_EXE);
  const j21 = path.join(root, 'b', 'bin', javaRuntime.JAVA_EXE);
  await writeFileWithDirs(j17, '');
  await writeFileWithDirs(j21, '');

  const picked = await javaRuntime.findJavaForTools({
    cache: [
      { path: j17, major: 17 },
      { path: j21, major: 21 }
    ]
  });
  assert.equal(picked, path.resolve(j21));
});

test('findJavaForTools：minMajor 可上调（21 时不选中 17）', async (t) => {
  const root = await tempDir(t);
  const j17 = path.join(root, 'a', 'bin', javaRuntime.JAVA_EXE);
  const j21 = path.join(root, 'b', 'bin', javaRuntime.JAVA_EXE);
  await writeFileWithDirs(j17, '');
  await writeFileWithDirs(j21, '');

  const picked = await javaRuntime.findJavaForTools({
    cache: [
      { path: j17, major: 17 },
      { path: j21, major: 21 }
    ],
    minMajor: 21
  });
  assert.equal(picked, path.resolve(j21));
  assert.equal(javaRuntime.TOOLS_MIN_JAVA_MAJOR, 17);
});

test('参数化配置不会把 electron 拉进进程（纯 node 可加载）', async (t) => {
  withoutJarEnv(t);
  const resources = await tempDir(t);
  mcdl.configure({ isPackaged: true, resourcesPath: resources, userData: await tempDir(t) });
  t.after(() => mcdl.configure({ isPackaged: false, resourcesPath: '', userData: '' }));

  assert.equal(typeof mcdl.resolveMcdlJar(), 'string');
  assert.equal(typeof javaRuntime.bundledJava(), 'object');

  const electronEntries = Object.keys(require.cache).filter((file) => {
    const normalized = file.split(path.sep).join('/');
    return /\/node_modules\/electron\//.test(normalized) || /\/electron\/main\.js$/.test(normalized);
  });
  assert.deepEqual(electronEntries, []);
});
