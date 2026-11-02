'use strict';

/**
 * java-install 测试：Adoptium 下载 URL 拼接与"已安装则复用"的目录发现。
 *
 * 真正的下载 / 解压要访问网络并解压几百 MB，不放进单测；
 * 这里守住的是最容易写错、又不需要联网的部分：URL 里的版本与架构，
 * 以及 findInstalled 的版本号匹配（写错就会重复下载或复用错版本的 JDK）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const javaInstall = require('../java-install');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-java-install-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 与实现一致的架构映射：arm64 → aarch64、ia32 → x86、其余 x64。 */
function expectedArch() {
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'ia32') return 'x86';
  return 'x64';
}

// ---------------- URL 拼接 ----------------

test('adoptiumUrl：按主版本与本机架构拼出 Windows JDK 下载地址', () => {
  assert.equal(
    javaInstall.adoptiumUrl(21),
    `https://api.adoptium.net/v3/binary/latest/21/windows/${expectedArch()}/jdk/hotspot/normal/eclipse?project=jdk`
  );
  assert.equal(
    javaInstall.adoptiumUrl(8),
    `https://api.adoptium.net/v3/binary/latest/8/windows/${expectedArch()}/jdk/hotspot/normal/eclipse?project=jdk`
  );
});

test('adoptiumUrl：非法 / 缺省主版本回落到 21', () => {
  const expected = javaInstall.adoptiumUrl(21);
  assert.equal(javaInstall.adoptiumUrl('abc'), expected);
  assert.equal(javaInstall.adoptiumUrl(undefined), expected);
  assert.equal(javaInstall.adoptiumUrl(0), expected);
});

test('SUPPORTED_MAJORS：只提供 LTS 主版本', () => {
  assert.deepEqual(javaInstall.SUPPORTED_MAJORS, [8, 11, 17, 21, 25]);
});

// ---------------- 已安装发现 ----------------

test('findInstalled：在 <destRoot>/temurin-<major> 里找到 java.exe', async (t) => {
  const root = await tempDir(t);
  const javaPath = path.join(root, 'temurin-21', 'bin', 'java.exe');
  await fs.mkdir(path.dirname(javaPath), { recursive: true });
  await fs.writeFile(javaPath, 'x');

  assert.equal(await javaInstall.findInstalled(root, 21), javaPath);
  assert.equal(await javaInstall.findInstalled(root, 17), '');
});

test('findInstalled：识别解压目录名里的版本号（jdk-17.0.2+8）', async (t) => {
  const root = await tempDir(t);
  const javaPath = path.join(root, 'jdk-17.0.2+8', 'bin', 'java.exe');
  await fs.mkdir(path.dirname(javaPath), { recursive: true });
  await fs.writeFile(javaPath, 'x');

  assert.equal(await javaInstall.findInstalled(root, 17), javaPath);
  assert.equal(await javaInstall.findInstalled(root, 21), '');
});

test('findInstalled：版本号只是前缀时不得误判（temurin-210 ≠ 21）', async (t) => {
  const root = await tempDir(t);
  const javaPath = path.join(root, 'temurin-210', 'bin', 'java.exe');
  await fs.mkdir(path.dirname(javaPath), { recursive: true });
  await fs.writeFile(javaPath, 'x');

  assert.equal(await javaInstall.findInstalled(root, 21), '');
});

test('findInstalled：目录存在但没有 bin/java.exe 时返回空', async (t) => {
  const root = await tempDir(t);
  await fs.mkdir(path.join(root, 'temurin-21'), { recursive: true });

  assert.equal(await javaInstall.findInstalled(root, 21), '');
});

test('findInstalled：安装根目录不存在时返回空而不是抛错', async (t) => {
  const root = await tempDir(t);
  assert.equal(await javaInstall.findInstalled(path.join(root, '不存在'), 21), '');
});
