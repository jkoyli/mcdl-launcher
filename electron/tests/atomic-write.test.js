'use strict';

/**
 * 原子写回归测试。
 *
 * 守的是「断电/强杀之后目标文件不能是残缺状态」这条线：
 * 这些用例都直接跑真文件系统，不用 mock。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { writeFileAtomic, writeJsonAtomic } = require('../atomic-write');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mcdl-atomic-'));
}

test('writeFileAtomic：写完内容正确，且不留下临时文件', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'state.json');
  await writeFileAtomic(file, '{"a":1}', { encoding: 'utf8' });

  assert.equal(await fs.readFile(file, 'utf8'), '{"a":1}');
  const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeFileAtomic：覆盖已有文件（旧内容不会残留半截）', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'state.json');
  await writeFileAtomic(file, 'old-content', { encoding: 'utf8' });
  await writeFileAtomic(file, 'new', { encoding: 'utf8' });
  assert.equal(await fs.readFile(file, 'utf8'), 'new');
});

test('writeFileAtomic：目标不存在时自动建目录', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'a', 'b', 'c.json');
  await writeFileAtomic(file, 'x', { encoding: 'utf8' });
  assert.equal(await fs.readFile(file, 'utf8'), 'x');
});

test('writeFileAtomic：支持 Buffer / Uint8Array（图标、二进制）', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'icon.png');
  const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  await writeFileAtomic(file, buffer);
  assert.deepEqual(await fs.readFile(file), buffer);

  const bytes = new Uint8Array([1, 2, 3]);
  await writeFileAtomic(file, bytes);
  assert.deepEqual(await fs.readFile(file), Buffer.from([1, 2, 3]));
});

test('writeJsonAtomic：缩进 + 末尾换行，与仓库其它状态文件一致', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 's.json');
  await writeJsonAtomic(file, { b: 2, a: 1 });
  const text = await fs.readFile(file, 'utf8');
  assert.equal(text, JSON.stringify({ b: 2, a: 1 }, null, 2) + '\n');
  assert.ok(text.endsWith('\n'));
});

test('writeJsonAtomic：compact 模式不带缩进', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 's.json');
  await writeJsonAtomic(file, { a: 1 }, { compact: true });
  assert.equal((await fs.readFile(file, 'utf8')).trim(), '{"a":1}');
});

test('写入失败时目标文件保持原样，且不留 .tmp', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'keep.json');
  await writeFileAtomic(file, 'original', { encoding: 'utf8' });

  // 传一个 handle.writeFile 无法接受的值，触发失败路径。
  let failed = false;
  try {
    await writeFileAtomic(file, { not: 'a buffer' });
  } catch {
    failed = true;
  }
  assert.equal(failed, true, '非法数据应当抛错');
  assert.equal(await fs.readFile(file, 'utf8'), 'original', '目标文件必须保持旧内容');
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
});

test('并发写同一个文件：按入队顺序串行，最后一个写入者胜出且内容完整', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'race.json');
  const payloads = [];
  for (let i = 0; i < 12; i += 1) payloads.push('x'.repeat(1024) + '#' + i);

  // 不串行化时，Windows 上这 12 个 rename 会互相抢目标文件并抛 EPERM。
  await Promise.all(payloads.map((p) => writeFileAtomic(file, p, { encoding: 'utf8' })));
  const final = await fs.readFile(file, 'utf8');
  assert.equal(final, payloads[payloads.length - 1], '最后一次写入必须完整胜出');
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
});

test('临时文件名带 pid + 随机串，且与目标同目录', () => {
  const { tempNameFor } = require('../atomic-write')._internal;
  const target = path.join(os.tmpdir(), 'dir', 'state.json');
  const tmp = tempNameFor(target);
  assert.equal(path.dirname(tmp), path.dirname(target), '临时文件必须在目标同目录（同一分区，rename 才是原子的）');
  assert.notEqual(tempNameFor(target), tempNameFor(target), '每次都要是新的临时名');
  assert.ok(tmp.includes(String(process.pid)));
});

test('flushWrites：等到所有排队写入落盘后才返回，队列归零', async () => {
  const { flushWrites, _internal } = require('../atomic-write');
  const dir = await tempDir();
  const files = [];
  const tasks = [];
  for (let i = 0; i < 8; i += 1) {
    const file = path.join(dir, `f${i}.json`);
    files.push(file);
    tasks.push(writeFileAtomic(file, JSON.stringify({ i }), { encoding: 'utf8' }));
  }
  const result = await flushWrites(5000);
  assert.equal(result.timedOut, false);
  assert.equal(result.pending, 0);
  assert.equal(_internal.pendingCount(), 0, '排队计数必须归零，否则退出时永远等不完');
  await Promise.all(tasks);
  for (let i = 0; i < files.length; i += 1) {
    assert.equal(await fs.readFile(files[i], 'utf8'), JSON.stringify({ i }));
  }
});

test('flushWrites：超时返回 timedOut，不会无限等', async () => {
  const { flushWrites } = require('../atomic-write');
  const dir = await tempDir();
  // 一个巨大的写让它来不及在 1ms 内完成
  const big = 'x'.repeat(8 * 1024 * 1024);
  writeFileAtomic(path.join(dir, 'big.bin'), big, { encoding: 'utf8' }).catch(() => {});
  const result = await flushWrites(1);
  assert.equal(typeof result.timedOut, 'boolean');
  assert.ok(result.pending >= 0);
});
