'use strict';

/**
 * modrinth.downloadFile 的完整性校验测试。
 *
 * 这里守住的是一条安全边界：模组 / 整合包内容最终会被游戏当代码加载，
 * 所以「拿不到期望哈希」必须直接拒绝下载，不存在「没哈希就直接落盘」。
 *
 * 真正的网络请求用注入的假 fetch 替代（不联网、不依赖 CDN）：
 *   - 有 sha512 → 用 sha512 校验；
 *   - 只有 sha1 → 用 sha1 校验；
 *   - 两者都没有 → 下载前就抛错，且目标路径不出现文件；
 *   - 哈希不符 → 抛错，且不留下半截文件 / .tmp 残渣。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const modrinth = require('../modrinth');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-modrinth-'));
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

/** 与实现一致：sha512 / sha1 的十六进制摘要。 */
function digest(algorithm, buffer) {
  return crypto.createHash(algorithm).update(buffer).digest('hex');
}

/**
 * 替换全局 fetch，记录调用次数，并在测试结束后恢复。
 * 返回的数组会被填充每次请求的 URL。
 */
function stubFetch(t, impl) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, options) => {
    urls.push(String(url));
    return impl(String(url), options);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return urls;
}

/** downloadFile 要求 response.body 为真值，这里给一个占位。 */
function okResponse(buffer) {
  return {
    ok: true,
    status: 200,
    body: {},
    arrayBuffer: async () => buffer
  };
}

const FILE_URL = 'https://cdn.modrinth.com/data/abc/versions/1.0/sodium-0.5.8.jar';

// ---------------- 有校验值：正常落盘 ----------------

test('downloadFile：有 sha512 时校验通过并写入文件', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'sodium.jar');
  const buffer = Buffer.from('sodium mod binary payload');
  const hashes = { sha512: digest('sha512', buffer), sha1: digest('sha1', buffer) };
  const urls = stubFetch(t, async () => okResponse(buffer));

  const saved = await modrinth.downloadFile(FILE_URL, target, hashes);

  assert.equal(saved.path, target);
  assert.equal(saved.size, buffer.length);
  assert.equal(await fs.readFile(target, 'utf8'), buffer.toString());
  // 有 sha512 且吻合，不需要回落到 sha1；请求只发一次。
  assert.equal(urls.length, 1);
});

test('downloadFile：只有 sha1 时用 sha1 校验通过', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'old-mod.jar');
  const buffer = Buffer.from('legacy mod without sha512');
  const urls = stubFetch(t, async () => okResponse(buffer));

  const saved = await modrinth.downloadFile(FILE_URL, target, { sha1: digest('sha1', buffer) });

  assert.equal(saved.size, buffer.length);
  assert.equal(await fs.readFile(target, 'utf8'), buffer.toString());
  assert.equal(urls.length, 1);
});

test('downloadFile：sha512 优先——sha1 对不上但 sha512 对得上仍通过', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'priority.jar');
  const buffer = Buffer.from('prefer sha512 over sha1');
  stubFetch(t, async () => okResponse(buffer));

  await modrinth.downloadFile(FILE_URL, target, {
    sha512: digest('sha512', buffer),
    sha1: 'f'.repeat(40)
  });

  assert.equal(await existsFile(target), true);
});

test('downloadFile：哈希比较大小写不敏感（Modrinth 偶尔给大写）', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'upper.jar');
  const buffer = Buffer.from('uppercase digest');
  stubFetch(t, async () => okResponse(buffer));

  await modrinth.downloadFile(FILE_URL, target, { sha1: digest('sha1', buffer).toUpperCase() });

  assert.equal(await existsFile(target), true);
});

// ---------------- 没有校验值：下载前拒绝 ----------------

test('downloadFile：sha512 / sha1 都没有时抛错，且不发请求、不写文件', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'no-hash.jar');
  const urls = stubFetch(t, async () => okResponse(Buffer.from('never fetched')));

  await assert.rejects(() => modrinth.downloadFile(FILE_URL, target, {}), (error) => {
    assert.match(error.message, /该文件没有提供校验值，已拒绝下载/);
    assert.match(error.message, /sodium-0\.5\.8\.jar/);
    return true;
  });

  assert.equal(urls.length, 0, '缺校验值必须在 fetch 之前拒绝');
  assert.equal(await existsFile(target), false);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('downloadFile：expectedHashes 为 undefined / null 时同样拒绝', async (t) => {
  const dir = await tempDir(t);
  stubFetch(t, async () => okResponse(Buffer.from('never fetched')));

  for (const value of [undefined, null, { sha512: '', sha1: '   ' }]) {
    await assert.rejects(
      () => modrinth.downloadFile(FILE_URL, path.join(dir, 'x.jar'), value),
      /没有提供校验值/,
      `hashes=${JSON.stringify(value)} 应该被拒绝`
    );
  }
  assert.deepEqual(await fs.readdir(dir), []);
});

// ---------------- 哈希不符：不留下半截文件 ----------------

test('downloadFile：sha1 不符时抛错，且不留下文件或 .tmp 残渣', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'tampered.jar');
  stubFetch(t, async () => okResponse(Buffer.from('tampered content')));

  await assert.rejects(
    () => modrinth.downloadFile(FILE_URL, target, { sha1: 'f'.repeat(40) }),
    (error) => {
      assert.match(error.message, /SHA1 校验失败/);
      return true;
    }
  );

  assert.equal(await existsFile(target), false);
  // writeFileAtomic 的临时文件也不能残留
  assert.deepEqual(await fs.readdir(dir), []);
});

test('downloadFile：sha512 不符时抛 SHA512 错误（不会悄悄退回 sha1）', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, 'bad-sha512.jar');
  const buffer = Buffer.from('sha512 mismatch');
  stubFetch(t, async () => okResponse(buffer));

  await assert.rejects(
    () =>
      modrinth.downloadFile(FILE_URL, target, {
        sha512: 'f'.repeat(128),
        sha1: digest('sha1', buffer)
      }),
    (error) => {
      assert.match(error.message, /SHA512 校验失败/);
      return true;
    }
  );
  assert.equal(await existsFile(target), false);
});

test('downloadFile：HTTP 非 2xx 时抛错（保持原有行为）', async (t) => {
  const dir = await tempDir(t);
  const target = path.join(dir, '404.jar');
  stubFetch(t, async () => ({ ok: false, status: 404, body: {} }));

  await assert.rejects(
    () => modrinth.downloadFile(FILE_URL, target, { sha1: 'a'.repeat(40) }),
    (error) => {
      assert.match(error.message, /下载失败（HTTP 404）/);
      return true;
    }
  );
  assert.equal(await existsFile(target), false);
});

// ---------------- 调用方：downloadVersion 同样受影响 ----------------

test('downloadVersion：主文件缺哈希时整次下载失败，且不写文件', async (t) => {
  const dir = await tempDir(t);
  stubFetch(t, async () => okResponse(Buffer.from('never fetched')));

  const version = {
    id: 'v1',
    file: { url: FILE_URL, filename: 'sodium.jar', size: 10, hashes: {} },
    dependencies: []
  };

  await assert.rejects(
    () => modrinth.downloadVersion({ version, targetDir: dir }),
    /该文件没有提供校验值，已拒绝下载/
  );
  assert.deepEqual(await fs.readdir(dir), []);
});

test('pickExpectedHash：优先 sha512，其次 sha1，都没有返回 null', () => {
  assert.deepEqual(modrinth.pickExpectedHash({ sha512: 'AA', sha1: 'bb' }), {
    algorithm: 'sha512',
    value: 'aa'
  });
  assert.deepEqual(modrinth.pickExpectedHash({ sha1: 'BB' }), { algorithm: 'sha1', value: 'bb' });
  assert.equal(modrinth.pickExpectedHash({}), null);
  assert.equal(modrinth.pickExpectedHash(null), null);
  assert.equal(modrinth.pickExpectedHash({ sha512: '', sha1: '' }), null);
});
