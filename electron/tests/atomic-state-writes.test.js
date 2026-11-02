'use strict';

/**
 * 「状态 / 用户数据落盘必须是原子的」行为测试。
 *
 * 覆盖两类回归：
 *   1. 写成功时落盘字节不变（账号 JSON 仍是 2 空格缩进、无末尾换行的历史格式；
 *      level.dat 仍是 level 6 的 gzip）——换实现不能顺手改格式；
 *   2. 写失败时旧文件保持原样、不留临时文件——这正是 HMCL 那类
 *      「断电后 version.json 变成半截」事故的反面。
 *
 * 说明：Windows 上「对只读目标做 rename」会稳定拿到 EPERM（atomic-write 会退避重试后
 * 抛错），所以失败路径用只读文件制造；POSIX 上 rename 不受文件只读位限制，这条跳过。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const nbt = require('../nbt');
const { createAccountStore } = require('../accounts');

const TMP_PREFIX = 'mcdl-atomic-state-';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function tempFilesIn(dir) {
  return (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
}

test('accounts：addOffline 落盘仍是 2 空格缩进、无末尾换行，且不留临时文件', async (t) => {
  const dir = await tempDir(t);
  const store = createAccountStore(dir);

  await store.addOffline('Steve');

  const raw = await fs.readFile(path.join(dir, 'accounts.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.selectedId, 'offline:steve');
  assert.equal(parsed.accounts.length, 1);
  // 原实现是 JSON.stringify(state, null, 2)，没有末尾换行；原子写不能改变落盘字节。
  assert.equal(raw, JSON.stringify(parsed, null, 2));
  assert.equal(raw.endsWith('\n'), false);

  assert.deepEqual(await tempFilesIn(dir), [], '写完不该留下 .tmp');
});

test('accounts：写入失败时旧账号文件保持原样，且不留临时文件', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('只有 Windows 上「rename 覆盖只读文件」会稳定失败');
    return;
  }

  const dir = await tempDir(t);
  const file = path.join(dir, 'accounts.json');
  const seeded = {
    accounts: [{
      id: 'offline:steve',
      type: 'offline',
      name: 'Steve',
      uuid: '8667ba71-b85a-4004-af54-457a9734eed7',
      accessToken: 'KEEP-ME',
      addedAt: '2024-01-01T00:00:00.000Z',
      lastUsedAt: null
    }],
    selectedId: 'offline:steve',
    servers: []
  };
  const original = JSON.stringify(seeded, null, 2);
  await fs.writeFile(file, original, 'utf8');

  const store = createAccountStore(dir);
  await fs.chmod(file, 0o444);
  t.after(() => fs.chmod(file, 0o666).catch(() => {}));

  await assert.rejects(
    () => store.addOffline('Alex'),
    /无法写入账号文件/,
    '落盘失败必须报错，不能静默当成成功'
  );

  // 目标文件一个字节都不该动，令牌还在。
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal(JSON.parse(original).accounts[0].accessToken, 'KEEP-ME');
  assert.deepEqual(await tempFilesIn(dir), [], '失败时临时文件必须被清掉');
});

test('nbt：level.dat 仍是 level 6 gzip（逐字节），且写失败时旧存档不变', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'level.dat');
  const root = {
    name: '',
    tag: {
      type: 'compound',
      value: new Map([
        ['Data', {
          type: 'compound',
          value: new Map([
            ['LevelName', { type: 'string', value: '我的世界 · 存档 A' }],
            ['version', { type: 'int', value: 19133 }]
          ])
        }]
      ])
    }
  };

  await nbt.writeFile(file, root);

  // 落盘格式必须和旧实现完全一致：serialize → gzip level 6。
  const expected = zlib.gzipSync(nbt.serialize(root), { level: 6 });
  const written = await fs.readFile(file);
  assert.deepEqual(written, expected);
  assert.equal(nbt.isGzip(written), true);

  // 非法 tag 让序列化阶段就失败：旧文件必须原样保留，且不留 .tmp-*。
  await assert.rejects(() => nbt.writeFile(file, { name: '', tag: { type: 'bogus' } }), /无法写入的 NBT tag/);
  assert.deepEqual(await fs.readFile(file), expected);

  const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});
