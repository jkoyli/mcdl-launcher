'use strict';

/**
 * 启动规格：**唯一能产出"可执行文件 + 参数"的地方。**
 *
 * 这里不判断"这个 Java 是不是可信来源"（那是 java-runtime.assertTrustedJava 的事），
 * 只保证三件事，避免"随便一个字符串就变成 spawn 的目标"：
 *   1. 可执行文件必须是本机绝对路径、文件名必须是 java/javaw（不是任意 exe）；
 *   2. 参数必须是字符串数组，不允许混进对象 / 函数 / 含 NUL 的串；
 *   3. 产出物冻结，spawn 只认这个对象，调用方无法在检查之后再改参数。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { assertLocalPath } = require('./path-guard');

const IS_WINDOWS = process.platform === 'win32';
const JAVA_NAME = IS_WINDOWS ? /^javaw?\.exe$/i : /^javaw?$/;

async function isFile(target) {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * 形状校验：路径形态 + 文件名 + 真的存在。
 * @returns {Promise<string>} 规范化后的路径
 */
async function assertJavaExecutableShape(javaPath) {
  const resolved = assertLocalPath(javaPath, 'Java 路径');
  if (!JAVA_NAME.test(path.basename(resolved))) {
    throw new Error(`Java 路径必须指向 ${IS_WINDOWS ? 'java.exe / javaw.exe' : 'java / javaw'}：${resolved}`);
  }
  if (!(await isFile(resolved))) {
    throw new Error(`Java 路径不存在或不是文件：${resolved}`);
  }
  return resolved;
}

/**
 * java.exe → javaw.exe（避免弹控制台）；javaw 不存在就继续用 java.exe。
 * 以前是无条件换名，javaw 缺失时 spawn 直接 ENOENT。
 */
async function resolveJavaExecutable(javaPath) {
  const resolved = await assertJavaExecutableShape(javaPath);
  if (IS_WINDOWS && /java\.exe$/i.test(resolved)) {
    const javaw = resolved.replace(/java\.exe$/i, 'javaw.exe');
    if (await isFile(javaw)) return javaw;
  }
  return resolved;
}

/**
 * @param {{javaPath:string, args:string[], gameDir:string}} plan
 * @param {{assertJava?:(javaPath:string)=>Promise<unknown>}} [options]
 *   assertJava：使用点授权校验（java-runtime.assertUsableJava）。放在这里是刻意的——
 *   任何新的启动调用方都必须经过 createLaunchSpec，从而绕不过授权表。
 * @returns {Promise<Readonly<{executable:string, args:readonly string[], gameDir:string}>>}
 */
async function createLaunchSpec(plan, options = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('启动计划无效');

  if (typeof options.assertJava === 'function') {
    await options.assertJava(plan.javaPath);
  }

  const executable = await resolveJavaExecutable(plan.javaPath);

  const rawArgs = plan.args;
  if (!Array.isArray(rawArgs)) throw new Error('启动参数必须是数组');
  for (const arg of rawArgs) {
    if (typeof arg !== 'string') throw new Error('启动参数只能是字符串');
    if (arg.includes('\0')) throw new Error('启动参数含有非法字符');
  }

  const gameDir = assertLocalPath(plan.gameDir, '游戏目录');

  return Object.freeze({
    executable,
    args: Object.freeze(rawArgs.slice()),
    gameDir
  });
}

module.exports = {
  assertJavaExecutableShape,
  resolveJavaExecutable,
  createLaunchSpec
};
