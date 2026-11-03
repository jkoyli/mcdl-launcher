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
const { createHash } = require('node:crypto');

const javaInstall = require('../java-install');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-java-install-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function existsFile(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
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

// ---------------- assets 接口 ----------------

test('adoptiumAssetsUrl：带 os/架构/image_type=jdk', () => {
  assert.equal(
    javaInstall.adoptiumAssetsUrl(17),
    `https://api.adoptium.net/v3/assets/latest/17/hotspot?os=windows&architecture=${expectedArch()}&image_type=jdk`
  );
  // 非法主版本回落 21，与 adoptiumUrl 一致
  assert.equal(javaInstall.adoptiumAssetsUrl('abc'), javaInstall.adoptiumAssetsUrl(21));
});

test('pickAdoptiumAsset：正常响应取出 link / checksum / size', () => {
  const payload = [
    {
      binary: {
        package: {
          link: 'https://github.com/adoptium/temurin21-binaries/jdk.zip',
          checksum: 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
          size: 190000000
        }
      }
    }
  ];
  const asset = javaInstall.pickAdoptiumAsset(payload);
  assert.equal(asset.link, 'https://github.com/adoptium/temurin21-binaries/jdk.zip');
  assert.equal(asset.checksum, 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
  assert.equal(asset.size, 190000000);
});

test('pickAdoptiumAsset：缺 package / 数组为空 / 非数组 一律返回 null（触发降级）', () => {
  assert.equal(javaInstall.pickAdoptiumAsset([]), null);
  assert.equal(javaInstall.pickAdoptiumAsset(null), null);
  assert.equal(javaInstall.pickAdoptiumAsset({}), null);
  assert.equal(javaInstall.pickAdoptiumAsset([{}]), null);
  assert.equal(javaInstall.pickAdoptiumAsset([{ binary: {} }]), null);
  assert.equal(javaInstall.pickAdoptiumAsset([{ binary: { package: { size: 1 } } }]), null);
  assert.equal(javaInstall.pickAdoptiumAsset([{ binary: { package: { link: '   ', checksum: '' } } }]), null);
});

test('pickAdoptiumAsset：缺 checksum 时只做解析（checksum 为空串、size 归一为 0）', () => {
  const asset = javaInstall.pickAdoptiumAsset([
    { binary: { package: { link: 'https://cdn.example/jdk.zip', size: 'nope' } } }
  ]);
  assert.equal(asset.link, 'https://cdn.example/jdk.zip');
  assert.equal(asset.checksum, '');
  assert.equal(asset.size, 0);
});

// ---------------- 校验和 / 大小 纯函数 ----------------

test('normalizeSha256：合法 hex 转小写，非法/空值返回空串', () => {
  const hex = 'a'.repeat(64);
  assert.equal(javaInstall.normalizeSha256(hex), hex);
  assert.equal(javaInstall.normalizeSha256(hex.toUpperCase()), hex);
  assert.equal(javaInstall.normalizeSha256(`  ${hex.toUpperCase()}  `), hex);
  assert.equal(javaInstall.normalizeSha256(''), '');
  assert.equal(javaInstall.normalizeSha256(null), '');
  assert.equal(javaInstall.normalizeSha256(undefined), '');
  assert.equal(javaInstall.normalizeSha256('not-a-hash'), '');
  assert.equal(javaInstall.normalizeSha256('a'.repeat(63)), '');
});

test('sha256Matches：大小写不敏感，空值不算匹配', () => {
  const hex = '0123456789abcdef'.repeat(4);
  assert.equal(javaInstall.sha256Matches(hex, hex), true);
  assert.equal(javaInstall.sha256Matches(hex.toUpperCase(), hex), true);
  assert.equal(javaInstall.sha256Matches(hex, hex.toUpperCase()), true);
  assert.equal(javaInstall.sha256Matches(hex, 'f'.repeat(64)), false);
  assert.equal(javaInstall.sha256Matches('', hex), false);
  assert.equal(javaInstall.sha256Matches(hex, ''), false);
  assert.equal(javaInstall.sha256Matches(null, undefined), false);
});

test('computeSha256：与 node:crypto 对同一内容的结果一致', async (t) => {
  const root = await tempDir(t);
  const file = path.join(root, 'blob.bin');
  const content = Buffer.from('MCDL Launcher java-install checksum test');
  await fs.writeFile(file, content);

  const expected = createHash('sha256').update(content).digest('hex');
  assert.equal(await javaInstall.computeSha256(file), expected);
});

// ---------------- verifyDownload ----------------

/** 造一个真实文件并返回 { file, size, sha256 }。 */
async function makeBlob(t, content) {
  const root = await tempDir(t);
  const file = path.join(root, 'jdk.zip');
  const buffer = Buffer.from(content);
  await fs.writeFile(file, buffer);
  return {
    file,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex')
  };
}

test('verifyDownload：size + SHA-256 都对时通过', async (t) => {
  const blob = await makeBlob(t, 'temurin-21-payload');
  const result = await javaInstall.verifyDownload(blob.file, {
    sha256: blob.sha256,
    size: blob.size
  });
  assert.equal(result.verified, true);
  assert.equal(result.sha256Checked, true);
  assert.equal(result.sizeChecked, true);
  assert.equal(result.bytes, blob.size);
  assert.equal(result.sha256, blob.sha256);
  // 校验通过不删文件（后面还要解压）
  assert.equal(await existsFile(blob.file), true);
});

test('verifyDownload：期望 checksum 大写也能通过', async (t) => {
  const blob = await makeBlob(t, 'upper-case-hex');
  const result = await javaInstall.verifyDownload(blob.file, {
    sha256: blob.sha256.toUpperCase(),
    size: blob.size
  });
  assert.equal(result.verified, true);
  assert.equal(result.sha256, blob.sha256);
});

test('verifyDownload：SHA-256 不符时抛中文错误并删除文件', async (t) => {
  const blob = await makeBlob(t, 'corrupted-by-a-hijacker');
  const wrong = 'f'.repeat(64);
  await assert.rejects(
    () => javaInstall.verifyDownload(blob.file, { sha256: wrong, size: blob.size }),
    (error) => {
      assert.match(error.message, /JDK 下载校验失败/);
      assert.match(error.message, /期望 SHA-256/);
      assert.match(error.message, /实际/);
      assert.match(error.message, /网络被劫持|CDN/);
      return true;
    }
  );
  assert.equal(await existsFile(blob.file), false, '校验失败必须删掉坏包');
});

test('verifyDownload：大小不符时抛中文错误并删除文件（不白算哈希）', async (t) => {
  const blob = await makeBlob(t, 'truncated');
  await assert.rejects(
    () => javaInstall.verifyDownload(blob.file, { sha256: blob.sha256, size: blob.size + 10 }),
    (error) => {
      assert.match(error.message, /JDK 下载校验失败/);
      assert.match(error.message, /期望大小/);
      return true;
    }
  );
  assert.equal(await existsFile(blob.file), false);
});

test('verifyDownload：没有 checksum 时抛错并删除文件（不允许只比大小）', async (t) => {
  const blob = await makeBlob(t, 'no-checksum-available');
  await assert.rejects(
    () => javaInstall.verifyDownload(blob.file, { sha256: '', size: blob.size }),
    (error) => {
      assert.match(error.message, /Adoptium 未提供该 JDK 的校验值/);
      assert.match(error.message, /已中止安装/);
      assert.match(error.message, /系统里已有的 JDK/);
      return true;
    }
  );
  assert.equal(await existsFile(blob.file), false, '未校验的安装包不能留在盘上');
});

test('verifyDownload：checksum / size 都没有时同样拒绝，并删除文件', async (t) => {
  const blob = await makeBlob(t, 'nothing-to-compare');
  await assert.rejects(
    () => javaInstall.verifyDownload(blob.file, {}),
    (error) => {
      assert.match(error.message, /未提供该 JDK 的校验值/);
      return true;
    }
  );
  assert.equal(await existsFile(blob.file), false);
});

test('verifyDownload：checksum 是非法的短串时也拒绝（不能当成合法哈希）', async (t) => {
  const blob = await makeBlob(t, 'bogus-checksum');
  await assert.rejects(
    () => javaInstall.verifyDownload(blob.file, { sha256: 'deadbeef', size: blob.size }),
    (error) => {
      assert.match(error.message, /校验值/);
      return true;
    }
  );
  assert.equal(await existsFile(blob.file), false);
});

test('checksumMismatchMessage / sizeMismatchMessage：用户可见文案可直接展示', () => {
  const expected = 'a'.repeat(64);
  const actual = 'b'.repeat(64);
  const message = javaInstall.checksumMismatchMessage(expected, actual);
  assert.ok(message.includes(expected));
  assert.ok(message.includes(actual));
  assert.ok(message.includes('选择 Java'));

  const sizeMessage = javaInstall.sizeMismatchMessage(1000, 900);
  assert.ok(sizeMessage.includes('1000'));
  assert.ok(sizeMessage.includes('900'));
  assert.ok(sizeMessage.includes('选择 Java'));
});

// ---------------- 下载来源解析（assets → 直链降级） ----------------

/** 注入假 fetch，并吞掉降级路径的 console.warn。 */
async function withFakeFetch(t, impl) {
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = originalWarn;
  });
  return impl;
}

test('resolveDownloadSource：assets 正常时用 link + checksum + size，不算降级', async (t) => {
  const hex = 'c'.repeat(64);
  const fetchImpl = await withFakeFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => [
      { binary: { package: { link: 'https://cdn.example/jdk21.zip', checksum: hex, size: 1234 } } }
    ]
  }));

  const source = await javaInstall.resolveDownloadSource(21, { fetchImpl });
  assert.equal(source.url, 'https://cdn.example/jdk21.zip');
  assert.equal(source.sha256, hex);
  assert.equal(source.size, 1234);
  assert.equal(source.degraded, false);
});

test('resolveDownloadSource：assets 非 200 时抛错，不再降级直链下载', async (t) => {
  const fetchImpl = await withFakeFetch(t, async () => ({ ok: false, status: 503 }));

  await assert.rejects(() => javaInstall.resolveDownloadSource(17, { fetchImpl }), (error) => {
    assert.match(error.message, /未提供该 JDK 的校验值/);
    assert.match(error.message, /已中止安装/);
    // 技术原因要保留，方便排查（503）
    assert.match(error.message, /503/);
    // 绝不能把用户引向 binary/latest 直链
    assert.ok(!error.message.includes('直链'), error.message);
    return true;
  });
});

test('resolveDownloadSource：响应结构变化（空数组）时也抛错，不降级', async (t) => {
  const fetchImpl = await withFakeFetch(t, async () => ({ ok: true, status: 200, json: async () => [] }));

  await assert.rejects(() => javaInstall.resolveDownloadSource(8, { fetchImpl }), (error) => {
    assert.match(error.message, /未提供该 JDK 的校验值/);
    assert.match(error.message, /binary\.package/);
    return true;
  });
});

test('resolveDownloadSource：assets 缺 checksum 时必须抛错，绝不下载未校验的包', async (t) => {
  let downloaded = false;
  const fetchImpl = await withFakeFetch(t, async (url) => {
    // 只有 assets 查询允许发生；一旦有人去请求 zip 直链就记下来。
    if (!String(url).includes('/assets/latest/')) {
      downloaded = true;
      throw new Error('不应该下载安装包');
    }
    return {
      ok: true,
      status: 200,
      json: async () => [{ binary: { package: { link: 'https://cdn.example/jdk8.zip', size: 999 } } }]
    };
  });

  await assert.rejects(() => javaInstall.resolveDownloadSource(8, { fetchImpl }), (error) => {
    assert.match(error.message, /未提供该 JDK 的校验值/);
    assert.match(error.message, /binary\.package\.checksum/);
    assert.match(error.message, /系统里已有的 JDK/);
    return true;
  });
  assert.equal(downloaded, false, '缺校验值不得发起安装包下载');
});

test('missingChecksumMessage：文案可行动（说明原因 + 重试 / 用系统 JDK）', () => {
  const message = javaInstall.missingChecksumMessage('HTTP 503');
  assert.match(message, /Adoptium 未提供该 JDK 的校验值/);
  assert.match(message, /HTTP 503/);
  assert.match(message, /请稍后重试或改用系统里已有的 JDK/);
});

test('installJava：缺 checksum 时中止安装，不下载、不解压、不落目录', async (t) => {
  const root = await tempDir(t);
  const requested = [];
  const fetchImpl = await withFakeFetch(t, async (url) => {
    requested.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => [{ binary: { package: { link: 'https://cdn.example/jdk21.zip', size: 1234 } } }]
    };
  });

  await assert.rejects(
    () => javaInstall.installJava({ major: 21, destRoot: root, fetchImpl }),
    (error) => {
      assert.match(error.message, /未提供该 JDK 的校验值/);
      return true;
    }
  );

  // 只查过 assets，没有去取 zip；安装根目录里也没有留下任何东西。
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/assets\/latest\/21\//);
  assert.deepEqual(await fs.readdir(root), []);
});

test('resolveDownloadSource：AbortError 必须往上抛，不能当成降级继续下载', async (t) => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const fetchImpl = await withFakeFetch(t, async () => {
    throw abort;
  });

  await assert.rejects(() => javaInstall.resolveDownloadSource(21, { fetchImpl }), (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
});

// ---------------- 国内镜像（清华 TUNA） ----------------

const MIRROR_LINK =
  'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/' +
  'OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip';

test('mirrorUrlFor：官方 GitHub 直链 → 清华 TUNA 同文件名路径', () => {
  assert.equal(
    javaInstall.mirrorUrlFor(MIRROR_LINK, 21, 'x64'),
    'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/' +
      'OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip'
  );
  // Java 8 的命名风格（8u504b01）也要认
  assert.equal(
    javaInstall.mirrorUrlFor(
      'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u504-b01/' +
        'OpenJDK8U-jdk_x64_windows_hotspot_8u504b01.zip',
      8,
      'x64'
    ),
    'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/8/jdk/x64/windows/' +
      'OpenJDK8U-jdk_x64_windows_hotspot_8u504b01.zip'
  );
});

test('mirrorUrlFor：文件名不认识 / 非法 URL 返回空串（调用方回退官方）', () => {
  assert.equal(javaInstall.mirrorUrlFor('https://cdn.example/jdk21.zip', 21, 'x64'), '');
  assert.equal(javaInstall.mirrorUrlFor('not a url', 21, 'x64'), '');
  assert.equal(javaInstall.mirrorUrlFor('', 21, 'x64'), '');
  // 只要文件名，host / 路径里的伪装不会带进镜像地址
  assert.equal(
    javaInstall.mirrorUrlFor(
      'https://evil.example/../../OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip',
      21,
      'x64'
    ),
    'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/' +
      'OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip'
  );
});

test('downloadUrlsFor：auto 镜像优先、official 只官方、mirror 只镜像', () => {
  const source = { url: 'https://github.com/x/jdk.zip', mirrorUrl: 'https://tuna/jdk.zip' };

  assert.deepEqual(javaInstall.downloadUrlsFor(source, 'auto'), [
    'https://tuna/jdk.zip',
    'https://github.com/x/jdk.zip'
  ]);
  assert.deepEqual(javaInstall.downloadUrlsFor(source, 'official'), ['https://github.com/x/jdk.zip']);
  assert.deepEqual(javaInstall.downloadUrlsFor(source, 'mirror'), ['https://tuna/jdk.zip']);
  // 推不出镜像地址时，mirror 也要回退官方，不能直接失败
  assert.deepEqual(javaInstall.downloadUrlsFor({ url: 'https://github.com/x/jdk.zip' }, 'mirror'), [
    'https://github.com/x/jdk.zip'
  ]);
  // 坏模式按 auto 处理
  assert.deepEqual(javaInstall.downloadUrlsFor(source, 'nope'), [
    'https://tuna/jdk.zip',
    'https://github.com/x/jdk.zip'
  ]);
});

test('normalizeJavaSource：合法值原样、非法值回落 auto', () => {
  assert.equal(javaInstall.normalizeJavaSource('auto'), 'auto');
  assert.equal(javaInstall.normalizeJavaSource('OFFICIAL'), 'official');
  assert.equal(javaInstall.normalizeJavaSource('mirror'), 'mirror');
  assert.equal(javaInstall.normalizeJavaSource(''), 'auto');
  assert.equal(javaInstall.normalizeJavaSource('tuna'), 'auto');
  assert.equal(javaInstall.normalizeJavaSource(undefined), 'auto');
});

test('resolveDownloadSource：响应里带上镜像地址（官方 link 不变）', async (t) => {
  const hex = 'd'.repeat(64);
  const fetchImpl = await withFakeFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => [{ binary: { package: { link: MIRROR_LINK, checksum: hex, size: 1234 } } }]
  }));

  const source = await javaInstall.resolveDownloadSource(21, { fetchImpl });
  assert.equal(source.url, MIRROR_LINK);
  assert.equal(
    source.mirrorUrl,
    'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/' +
      'OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip'
  );
  assert.equal(source.sha256, hex);
});

