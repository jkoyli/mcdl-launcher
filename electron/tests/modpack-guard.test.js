'use strict';

/**
 * modpack-guard 测试：整合包预检（zip-slip / ADS / 保留名 / 链接条目 / 炸弹）
 * 与一次性安装许可 token。
 *
 * 这里的每个"拒绝"都对应一种真实的攻击面，所以断言要落在具体原因上，
 * 而不是"只要报错就算过"。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const guard = require('../modpack-guard');

async function tempDir(t, prefix = 'mcdl-modpack-guard-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function tryJunction(target, linkPath) {
  try {
    await fs.symlink(target, linkPath, 'junction');
    return true;
  } catch {
    return false;
  }
}

// ---------------- 条目名安全检查（zip-slip 的核心） ----------------

test('entryProblem：普通相对路径与中文/空格路径放行', () => {
  assert.equal(guard.entryProblem('manifest.json'), null);
  assert.equal(guard.entryProblem('mods/example-mod-1.0.jar'), null);
  assert.equal(guard.entryProblem('overrides/config/我的 配置.toml'), null);
  assert.equal(guard.entryProblem('overrides/saves/新 存档/level.dat'), null);
  assert.equal(guard.entryProblem('dir/'), null, '目录条目无需内容检查');
  assert.equal(guard.entryProblem(''), null);
});

test('entryProblem：拦截 .. 穿越（含反斜杠写法）', () => {
  assert.equal(guard.entryProblem('mods/../../evil.jar'), '条目使用 .. 穿越');
  assert.equal(guard.entryProblem('../evil.jar'), '条目使用 .. 穿越');
  assert.equal(guard.entryProblem('mods\\..\\evil.jar'), '条目使用 .. 穿越');
  assert.equal(guard.entryProblem('..\\..\\Windows\\System32\\evil.dll'), '条目使用 .. 穿越');
});

test('entryProblem：拦截绝对路径与盘符', () => {
  assert.equal(guard.entryProblem('/etc/passwd'), '条目使用绝对路径');
  assert.equal(guard.entryProblem('\\Windows\\evil.dll'), '条目使用绝对路径');
  assert.equal(guard.entryProblem('C:/Windows/System32/evil.dll'), '条目带盘符');
  assert.equal(guard.entryProblem('C:\\Windows\\evil.dll'), '条目带盘符');
});

test('entryProblem：拦截 NTFS 备选数据流（ADS）', () => {
  assert.equal(guard.entryProblem('mods/a.jar:evil.exe'), '条目名含备选数据流（ADS）');
});

test('entryProblem：拦截 NUL 与首尾空格', () => {
  assert.equal(guard.entryProblem('mods/a\0.jar'), '条目名含 NUL');
  assert.equal(guard.entryProblem(' mods/a.jar'), '条目名含首尾空格');
  assert.equal(guard.entryProblem('mods /a.jar'), '条目名含首尾空格');
  assert.equal(guard.entryProblem('mods/a.jar '), '条目名含首尾空格');
});

test('entryProblem：拦截 Windows 保留名（含带扩展名的写法）', () => {
  assert.equal(guard.entryProblem('CON'), '条目使用 Windows 保留名');
  assert.equal(guard.entryProblem('mods/con.txt'), '条目使用 Windows 保留名');
  assert.equal(guard.entryProblem('mods/AUX.log'), '条目使用 Windows 保留名');
  assert.equal(guard.entryProblem('mods/nul.json'), '条目使用 Windows 保留名');
  assert.equal(guard.entryProblem('mods/lpt9.log'), '条目使用 Windows 保留名');
  assert.equal(guard.entryProblem('mods/com1'), '条目使用 Windows 保留名');
  // console.txt 不是保留名（保留名要求 con 后面直接是点或结尾）
  assert.equal(guard.entryProblem('mods/console.txt'), null);
});

test('entryProblem：拦截以点结尾的条目名', () => {
  assert.equal(guard.entryProblem('mods/evil.'), '条目名以点或空格结尾');
});

// ---------------- 链接条目识别 ----------------

function unixEntry(mode, host = 3) {
  return { madeBy: (host << 8) >>> 0, externalAttrs: ((mode << 16) >>> 0) };
}

test('isLinkEntry：unix 符号链接条目被识别为链接', () => {
  assert.equal(guard.isLinkEntry(unixEntry(0xa000)), true);
});

test('isLinkEntry：unix 普通文件 / 目录 / 未知模式不乱判', () => {
  assert.equal(guard.isLinkEntry(unixEntry(0x8000)), false);
  assert.equal(guard.isLinkEntry(unixEntry(0x4000)), false);
  assert.equal(guard.isLinkEntry(unixEntry(0)), false);
  // 设备 / fifo / socket 也不该出现在整合包里
  assert.equal(guard.isLinkEntry(unixEntry(0x1000)), true);
  assert.equal(guard.isLinkEntry(unixEntry(0xc000)), true);
});

test('isLinkEntry：Windows 条目按 reparse point 属性位判断', () => {
  assert.equal(guard.isLinkEntry({ madeBy: 20, externalAttrs: 0x400 }), true);
  assert.equal(guard.isLinkEntry({ madeBy: 20, externalAttrs: 0x10 }), false);
  assert.equal(guard.isLinkEntry({ madeBy: 20, externalAttrs: 0x20 }), false);
  assert.equal(guard.isLinkEntry({ madeBy: 20, externalAttrs: 0 }), false);
});

// ---------------- 预检入口 ----------------

test('prepare：UNC 路径在碰到文件系统之前就被拒绝', async () => {
  await assert.rejects(
    guard.prepare('\\\\attacker\\share\\pack.zip'),
    /网络路径或设备路径/
  );
});

test('prepare：文件不存在时报"找不到整合包"', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(guard.prepare(path.join(dir, 'missing.zip')), /找不到整合包文件/);
});

test('prepare：目录冒充整合包时拒绝', async (t) => {
  const dir = await tempDir(t);
  const fake = path.join(dir, 'pack.zip');
  await fs.mkdir(fake);
  await assert.rejects(guard.prepare(fake), /必须是一个普通文件/);
});

test('prepare：空文件与错误扩展名分别拒绝', async (t) => {
  const dir = await tempDir(t);
  const empty = path.join(dir, 'empty.zip');
  await fs.writeFile(empty, '');
  await assert.rejects(guard.prepare(empty), /空文件/);

  const wrongExt = path.join(dir, 'pack.rar');
  await fs.writeFile(wrongExt, 'x'.repeat(64));
  await assert.rejects(guard.prepare(wrongExt), /只支持 \.zip \/ \.mrpack/);
});

test('prepare：扩展名对但内容不是 zip 时报中央目录错误', async (t) => {
  const dir = await tempDir(t);
  const junk = path.join(dir, 'junk.zip');
  await fs.writeFile(junk, Buffer.alloc(64, 0x41));
  await assert.rejects(guard.prepare(junk), /找不到中央目录/);

  const tiny = path.join(dir, 'tiny.zip');
  await fs.writeFile(tiny, Buffer.from('PK'));
  await assert.rejects(guard.prepare(tiny), /不是有效的 zip 文件/);
});

test('readCentralDirectory：过小的文件直接判为无效 zip', async (t) => {
  const dir = await tempDir(t);
  const tiny = path.join(dir, 'tiny.zip');
  await fs.writeFile(tiny, Buffer.alloc(10));
  await assert.rejects(guard.readCentralDirectory(tiny), /不是有效的 zip 文件/);
});

// ---------------- 一次性 token ----------------

/**
 * 手工拼一个"只含中央目录"的最小 zip。
 * prepare 只读中央目录（不执行内容），所以这足够驱动真实的预检逻辑，
 * 又能精确控制条目名 / 大小 / host 属性来构造恶意包。
 */
function fakeZip(entries) {
  const parts = [];
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(entry.madeBy == null ? 20 : entry.madeBy, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(entry.compressed == null ? 50 : entry.compressed, 20);
    header.writeUInt32LE(entry.uncompressed == null ? 1000 : entry.uncompressed, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((entry.externalAttrs == null ? 0 : entry.externalAttrs) >>> 0, 38);
    header.writeUInt32LE(0, 42);
    parts.push(header, nameBuf);
  }

  const cd = Buffer.concat(parts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([cd, eocd]);
}

async function writeFakeZip(dir, name, entries) {
  const file = path.join(dir, name);
  await fs.writeFile(file, fakeZip(entries));
  return file;
}

test('prepare：合规整合包发放 token 并返回摘要信息', async (t) => {
  guard._resetTokens();
  const dir = await tempDir(t);
  const pack = await writeFakeZip(dir, 'pack.zip', [
    { name: 'manifest.json', uncompressed: 1000, compressed: 50 },
    { name: 'overrides/mods/我的 模组.jar', uncompressed: 2000, compressed: 500 }
  ]);

  const result = await guard.prepare(pack);
  assert.match(result.token, /^[0-9a-f]{48}$/);
  assert.equal(result.info.file, 'pack.zip');
  assert.equal(result.info.entryCount, 2);
  assert.equal(result.info.uncompressedBytes, 3000);
  assert.equal(result.info.manifest, 'manifest.json');
});

test('prepare：条目带 .. 穿越时整体拒绝并列出问题', async (t) => {
  guard._resetTokens();
  const dir = await tempDir(t);
  const pack = await writeFakeZip(dir, 'evil.zip', [
    { name: 'manifest.json' },
    { name: 'overrides/../../evil.jar' }
  ]);

  await assert.rejects(guard.prepare(pack), (error) => {
    assert.equal(error.code, 'EPACKUNSAFE');
    assert.ok(error.problems.some((item) => item.includes('.. 穿越')));
    return true;
  });
});

test('prepare：包含链接条目时整体拒绝', async (t) => {
  guard._resetTokens();
  const dir = await tempDir(t);
  const pack = await writeFakeZip(dir, 'link.zip', [
    { name: 'manifest.json' },
    { name: 'overrides/link', madeBy: (3 << 8) >>> 0, externalAttrs: ((0xa000 << 16) >>> 0) }
  ]);

  await assert.rejects(guard.prepare(pack), (error) => {
    assert.equal(error.code, 'EPACKUNSAFE');
    assert.ok(error.problems.some((item) => item.includes('链接条目')));
    return true;
  });
});

test('prepare：压缩比异常（zip bomb 特征）时拒绝', async (t) => {
  guard._resetTokens();
  const dir = await tempDir(t);
  const pack = await writeFakeZip(dir, 'bomb.zip', [
    { name: 'manifest.json', uncompressed: 10 * 1024 * 1024, compressed: 1024 }
  ]);

  await assert.rejects(guard.prepare(pack), (error) => {
    assert.equal(error.code, 'EPACKUNSAFE');
    assert.ok(error.problems.some((item) => item.includes('zip bomb')));
    return true;
  });
});

test('prepare / consume：token 只能用一次', async (t) => {
  guard._resetTokens();
  const dir = await tempDir(t);
  const pack = await writeFakeZip(dir, 'pack.zip', [{ name: 'manifest.json' }]);

  const { token } = await guard.prepare(pack);
  const record = guard.consume(token);
  assert.equal(record.entries, 1);

  assert.throws(() => guard.consume(token), (error) => {
    assert.equal(error.code, 'EPACKTOKEN');
    assert.match(error.message, /安装许可无效或已使用/);
    return true;
  });
});

test('assertUnchanged：文件在预检后被替换时拒绝安装', async (t) => {
  guard._resetTokens();
  const dir = await tempDir(t);
  const pack = await writeFakeZip(dir, 'pack.zip', [{ name: 'manifest.json' }]);

  const { token } = await guard.prepare(pack);
  const record = guard.consume(token);

  await guard.assertUnchanged(record);

  await fs.writeFile(pack, fakeZip([{ name: 'manifest.json' }, { name: 'injected.jar' }]));
  await assert.rejects(guard.assertUnchanged(record), (error) => {
    assert.equal(error.code, 'EPACKCHANGED');
    assert.match(error.message, /被修改过/);
    return true;
  });
});

test('consume：未发放 / 已过期的 token 一律拒绝', () => {
  guard._resetTokens();

  assert.throws(() => guard.consume('deadbeef'), (error) => {
    assert.equal(error.code, 'EPACKTOKEN');
    assert.match(error.message, /安装许可无效或已使用/);
    return true;
  });

  assert.throws(() => guard.consume(''), /安装许可无效或已使用/);
  assert.throws(() => guard.consume(null), /安装许可无效或已使用/);
});

// ---------------- 解压后核对 ----------------

test('verifyExtractedTree：统计文件数与体积', async (t) => {
  const root = await tempDir(t);
  await fs.mkdir(path.join(root, 'mods'), { recursive: true });
  await fs.writeFile(path.join(root, 'mods', 'a.jar'), 'aaaa');
  await fs.writeFile(path.join(root, 'manifest.json'), '{}');

  const result = await guard.verifyExtractedTree(root);
  assert.equal(result.files, 2);
  assert.equal(result.bytes, 6);
});

test('verifyExtractedTree：文件数超出预算时判为不安全', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'a.jar'), 'a');
  await fs.writeFile(path.join(root, 'b.jar'), 'b');

  await assert.rejects(guard.verifyExtractedTree(root, { maxFiles: 1 }), (error) => {
    assert.equal(error.code, 'EPACKUNSAFE');
    assert.ok(error.problems.some((item) => item.includes('文件数超过预算')));
    return true;
  });
});

test('verifyExtractedTree：体积超出预算时判为不安全', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'a.jar'), '0123456789');

  await assert.rejects(guard.verifyExtractedTree(root, { maxBytes: 4 }), (error) => {
    assert.equal(error.code, 'EPACKUNSAFE');
    assert.ok(error.problems.some((item) => item.includes('体积超过预算')));
    return true;
  });
});

test('verifyExtractedTree：解压结果里出现 junction / 符号链接时判为不安全', async (t) => {
  const root = await tempDir(t);
  const outside = await tempDir(t);
  await fs.writeFile(path.join(outside, 'secret.txt'), 's');

  if (!(await tryJunction(outside, path.join(root, 'escape')))) {
    t.skip('当前环境无法创建 junction / 符号链接');
    return;
  }

  await assert.rejects(guard.verifyExtractedTree(root), (error) => {
    assert.equal(error.code, 'EPACKUNSAFE');
    assert.ok(error.problems.length > 0);
    return true;
  });
});
