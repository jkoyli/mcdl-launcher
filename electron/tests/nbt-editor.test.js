'use strict';

/**
 * nbt-editor 测试：level.dat 的读取 → 展示 → 改标量 → 写回。
 *
 * 重点守两件事：
 *   1. 写出去再读回来必须等价（二进制往返最容易回归）；
 *   2. 类型必须按原 tag 保留（byte 还是 byte、long 还是 long），
 *      否则 Minecraft 会直接把 level.dat 判为损坏。
 *
 * 顺带覆盖"哪些字段允许编辑"与"失败时不落盘"这两条安全边界。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const nbt = require('../nbt');
const editor = require('../nbt-editor');

const TMP_PREFIX = 'mcdl-nbt-editor-';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), TMP_PREFIX));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function compound(entries = []) {
  return { type: 'compound', value: new Map(entries) };
}

/** 造一份结构接近 level.dat 的 NBT 树。 */
function buildLevelDat() {
  const root = { name: '', tag: compound() };

  nbt.setInt(root, 19133, 'Data', 'version');
  nbt.setString(root, '我的世界 · 存档 A', 'Data', 'LevelName');
  nbt.setLong(root, 1234567890123n, 'Data', 'RandomSeed');
  nbt.setByte(root, 1, 'Data', 'allowCommands');
  nbt.setInt(root, 42, 'Data', 'SpawnX');

  const data = root.tag.value.get('Data');

  data.value.set('Player', compound([
    ['Health', { type: 'float', value: 20 }],
    ['Inventory', {
      type: 'list',
      itemType: 10,
      value: [
        compound([['id', { type: 'string', value: 'minecraft:stone' }]]),
        compound([['id', { type: 'string', value: 'minecraft:dirt' }]])
      ]
    }],
    ['Motion', {
      type: 'list',
      itemType: 6,
      value: [
        { type: 'double', value: 0.5 },
        { type: 'double', value: -1.25 },
        { type: 'double', value: 0 }
      ]
    }]
  ]));

  data.value.set('Icon', { type: 'byteArray', value: Buffer.from([1, 2, 3, 4]) });
  data.value.set('Heightmap', { type: 'intArray', value: [7, 8, 9] });

  return root;
}

async function writeFixture(t) {
  const dir = await tempDir(t);
  const file = path.join(dir, 'level.dat');
  await nbt.writeFile(file, buildLevelDat());
  return file;
}

function rowAt(result, route) {
  const key = route.join('.');
  return result.rows.find((row) => row.path.join('.') === key);
}

// ---------------- 读取与展示 ----------------

test('load：读出根名、文件大小与 Data 下的标量行', async (t) => {
  const file = await writeFixture(t);
  const result = await editor.load(file);

  assert.equal(result.name, '');
  assert.ok(result.size > 0, '应报告文件字节数');
  assert.equal(result.truncated, false);

  const version = rowAt(result, ['Data', 'version']);
  assert.equal(version.type, 'int');
  assert.equal(version.value, '19133');
  assert.equal(version.editable, true);
  assert.equal(version.depth, 1);

  const levelName = rowAt(result, ['Data', 'LevelName']);
  assert.equal(levelName.type, 'string');
  assert.equal(levelName.value, '我的世界 · 存档 A');

  const seed = rowAt(result, ['Data', 'RandomSeed']);
  assert.equal(seed.type, 'long');
  assert.equal(seed.value, '1234567890123');
});

test('load：嵌套 compound 与 list 展开成带深度的行，且不可编辑', async (t) => {
  const file = await writeFixture(t);
  const result = await editor.load(file);

  const player = rowAt(result, ['Data', 'Player']);
  assert.equal(player.type, 'compound');
  assert.equal(player.editable, false);

  const health = rowAt(result, ['Data', 'Player', 'Health']);
  assert.equal(health.type, 'float');
  assert.equal(health.value, '20');
  assert.equal(health.depth, 2);
  assert.equal(health.editable, true);

  const firstSlot = rowAt(result, ['Data', 'Player', 'Inventory', '0', 'id']);
  assert.equal(firstSlot.type, 'string');
  assert.equal(firstSlot.value, 'minecraft:stone');

  const secondSlot = rowAt(result, ['Data', 'Player', 'Inventory', '1', 'id']);
  assert.equal(secondSlot.value, 'minecraft:dirt');
});

test('load：列表与定长数组只给摘要，不展开成上千行', async (t) => {
  const file = await writeFixture(t);
  const result = await editor.load(file);

  const inventory = rowAt(result, ['Data', 'Player', 'Inventory']);
  assert.equal(inventory.value, '[2 项 compound]');
  assert.equal(inventory.editable, false);

  // 标量列表不展开（只展示条数），避免刷屏
  const motion = rowAt(result, ['Data', 'Player', 'Motion']);
  assert.equal(motion.value, '[3 项 double]');
  assert.equal(rowAt(result, ['Data', 'Player', 'Motion', '0']), undefined);

  assert.equal(rowAt(result, ['Data', 'Icon']).value, '[4 字节]');
  assert.equal(rowAt(result, ['Data', 'Heightmap']).value, '[3 个整数]');
});

test('flatten：超过 4000 行时截断并标记 truncated', () => {
  const root = compound();
  for (let index = 0; index < 4200; index += 1) {
    root.value.set(`k${index}`, { type: 'int', value: index });
  }

  const result = editor.flatten(root);
  assert.equal(result.rows.length, 4000);
  assert.equal(result.truncated, true);
});

test('flatten：嵌套超过 16 层时用占位行省略，不再继续下钻', () => {
  let deepest = compound([['Leaf', { type: 'int', value: 1 }]]);
  for (let depth = 0; depth < 20; depth += 1) {
    deepest = compound([[`L${depth}`, deepest]]);
  }

  const result = editor.flatten(deepest);
  const truncatedRow = result.rows.find((row) => row.value === '（层级过深，已省略）');
  assert.ok(truncatedRow, '超过深度上限时应出现占位行');
  assert.equal(truncatedRow.editable, false);
});

// ---------------- 按路径定位 ----------------

test('resolveTag：支持 compound 字段名与 list 下标', () => {
  const root = buildLevelDat();

  assert.equal(editor.resolveTag(root, ['Data', 'version']).value, 19133);
  assert.equal(editor.resolveTag(root, ['Data', 'Player', 'Inventory', '1', 'id']).value, 'minecraft:dirt');
  assert.equal(editor.resolveTag(root, ['Data', 'Player', 'Motion', '2']).value, 0);
});

test('resolveTag：字段不存在、下标越界、穿过标量都返回 null', () => {
  const root = buildLevelDat();

  assert.equal(editor.resolveTag(root, ['Data', 'nope']), null);
  assert.equal(editor.resolveTag(root, ['Nope', 'deep']), null);
  assert.equal(editor.resolveTag(root, ['Data', 'Player', 'Inventory', '9']), null);
  assert.equal(editor.resolveTag(root, ['Data', 'Player', 'Inventory', '-1']), null);
  assert.equal(editor.resolveTag(root, ['Data', 'Player', 'Inventory', 'abc']), null);
  assert.equal(editor.resolveTag(root, ['Data', 'version', 'deeper']), null);
});

// ---------------- 写回往返 ----------------

test('save：改标量后写回，重新读出值正确且类型不变', async (t) => {
  const file = await writeFixture(t);

  const result = await editor.save(file, [
    { path: ['Data', 'LevelName'], value: '新的存档名字' },
    { path: ['Data', 'version'], value: '19134' },
    { path: ['Data', 'allowCommands'], value: '0' },
    { path: ['Data', 'RandomSeed'], value: '-987654321000' }
  ]);

  assert.equal(result.applied.length, 4);
  assert.ok(result.size > 0);

  const roundTrip = await nbt.readFile(file);
  assert.equal(nbt.getString(roundTrip, 'Data', 'LevelName'), '新的存档名字');
  assert.equal(nbt.getNumber(roundTrip, 'Data', 'version'), 19134);
  assert.equal(nbt.getNumber(roundTrip, 'Data', 'allowCommands'), 0);

  // 类型必须按原 tag 保留
  assert.equal(nbt.get(roundTrip, 'Data', 'version').type, 'int');
  assert.equal(nbt.get(roundTrip, 'Data', 'allowCommands').type, 'byte');
  assert.equal(nbt.get(roundTrip, 'Data', 'RandomSeed').type, 'long');
  assert.equal(nbt.get(roundTrip, 'Data', 'RandomSeed').value, -987654321000n);

  // 未改动的嵌套结构与二进制字段原样保留
  assert.equal(editor.resolveTag(roundTrip, ['Data', 'Player', 'Inventory', '0', 'id']).value, 'minecraft:stone');
  assert.deepEqual(
    Array.from(nbt.get(roundTrip, 'Data', 'Icon').value),
    [1, 2, 3, 4]
  );
});

test('save：覆盖前留一份 .bak，备份里仍是旧值', async (t) => {
  const file = await writeFixture(t);

  await editor.save(file, [{ path: ['Data', 'LevelName'], value: '改过的' }]);

  const backup = await nbt.readFile(`${file}.bak`);
  assert.equal(nbt.getString(backup, 'Data', 'LevelName'), '我的世界 · 存档 A');

  const current = await nbt.readFile(file);
  assert.equal(nbt.getString(current, 'Data', 'LevelName'), '改过的');
});

test('save：中文、空格与 emoji 字符串往返一致（UTF-8 长度正确）', async (t) => {
  const file = await writeFixture(t);
  const value = '存档 · 🐔 emoji 与 中文 混排';

  await editor.save(file, [{ path: ['Data', 'LevelName'], value }]);

  const roundTrip = await nbt.readFile(file);
  const stored = nbt.getString(roundTrip, 'Data', 'LevelName');
  assert.equal(stored, '存档 · 🐔 emoji 与 中文 混排');
  // 逐字符长度用来确认没有被截断在代理对上
  assert.equal([...stored].length, [...'存档 · 🐔 emoji 与 中文 混排'].length);
});

test('save：连续两次写回都能读回，不留半截文件', async (t) => {
  const file = await writeFixture(t);

  await editor.save(file, [{ path: ['Data', 'SpawnX'], value: '100' }]);
  await editor.save(file, [{ path: ['Data', 'SpawnX'], value: '200' }]);

  const roundTrip = await nbt.readFile(file);
  assert.equal(nbt.getNumber(roundTrip, 'Data', 'SpawnX'), 200);
});

// ---------------- 拒绝非法编辑 ----------------

test('save：compound / list 这类非标量字段不允许编辑', async (t) => {
  const file = await writeFixture(t);

  await assert.rejects(
    editor.save(file, [{ path: ['Data', 'Player'], value: 'x' }]),
    /不是可编辑的标量类型/
  );
  await assert.rejects(
    editor.save(file, [{ path: ['Data', 'Player', 'Inventory'], value: 'x' }]),
    /不是可编辑的标量类型/
  );
});

test('save：字段不存在时报错，且不写盘（文件字节不变）', async (t) => {
  const file = await writeFixture(t);
  const before = await fs.readFile(file);

  await assert.rejects(
    editor.save(file, [
      { path: ['Data', 'LevelName'], value: '先改一个合法字段' },
      { path: ['Data', 'NoSuchField'], value: 'x' }
    ]),
    /找不到字段/
  );

  const after = await fs.readFile(file);
  assert.deepEqual(after, before, '校验失败时不应留下部分写入');
});

test('save：空改动 / 全为无效项时拒绝，且不写盘', async (t) => {
  const file = await writeFixture(t);
  const before = await fs.readFile(file);

  await assert.rejects(editor.save(file, []), /没有要保存的改动/);
  await assert.rejects(editor.save(file), /没有要保存的改动/);
  await assert.rejects(editor.save(file, [{ path: [], value: 'x' }]), /没有有效改动/);
  await assert.rejects(editor.save(file, [null, { value: 'x' }]), /没有有效改动/);

  assert.deepEqual(await fs.readFile(file), before);
});

test('save：数字越界时按原类型报错，不静默截断', async (t) => {
  const file = await writeFixture(t);

  await assert.rejects(
    editor.save(file, [{ path: ['Data', 'allowCommands'], value: '128' }]),
    /不是合法的 byte/
  );
  await assert.rejects(
    editor.save(file, [{ path: ['Data', 'version'], value: '2147483648' }]),
    /不是合法的 int/
  );
});

// ---------------- parseValue 单点 ----------------

test('parseValue：byte / short / int 的边界值', () => {
  assert.equal(editor.parseValue('byte', '-128'), -128);
  assert.equal(editor.parseValue('byte', '127'), 127);
  assert.equal(editor.parseValue('short', '-32768'), -32768);
  assert.equal(editor.parseValue('short', '32767'), 32767);
  assert.equal(editor.parseValue('int', '-2147483648'), -2147483648);
  assert.equal(editor.parseValue('int', '2147483647'), 2147483647);
});

test('parseValue：越界、非整数、非数字一律报错', () => {
  assert.throws(() => editor.parseValue('byte', '128'), /不是合法的 byte/);
  assert.throws(() => editor.parseValue('byte', '-129'), /不是合法的 byte/);
  assert.throws(() => editor.parseValue('byte', '1.5'), /不是合法的 byte/);
  assert.throws(() => editor.parseValue('short', '32768'), /不是合法的 short/);
  assert.throws(() => editor.parseValue('int', '2147483648'), /不是合法的 int/);
  assert.throws(() => editor.parseValue('int', 'abc'), /不是合法的 int/);
  assert.throws(() => editor.parseValue('float', 'abc'), /不是合法的数字/);
  assert.throws(() => editor.parseValue('double', 'Infinity'), /不是合法的数字/);
});

test('parseValue：long 返回 BigInt，且拒绝非数字', () => {
  assert.equal(editor.parseValue('long', '42'), 42n);
  assert.equal(typeof editor.parseValue('long', '42'), 'bigint');
  assert.throws(() => editor.parseValue('long', 'abc'), /不是合法的 long/);
});

test('parseValue：不支持的 tag 类型直接拒绝', () => {
  assert.throws(() => editor.parseValue('compound', 'x'), /不支持编辑/);
  assert.throws(() => editor.parseValue('list', 'x'), /不支持编辑/);
  assert.throws(() => editor.parseValue('byteArray', 'x'), /不支持编辑/);
});

test('parseValue：超过 4096 字符的值被拒绝', () => {
  assert.throws(() => editor.parseValue('string', 'a'.repeat(4097)), /值太长/);
  assert.equal(editor.parseValue('string', 'a'.repeat(4096)).length, 4096);
});

test('parseValue：string 会裁掉首尾空白（记录现有行为，便于以后决定是否修）', () => {
  assert.equal(editor.parseValue('string', '  hello  '), 'hello');
});

test('parseValue：long 超过 2^53 不丢精度（回归：曾静默改掉世界种子）', () => {
  // 9007199254740993 = 2^53 + 1，Number 无法精确表示——这里必须是精确的 BigInt。
  assert.equal(editor.parseValue('long', '9007199254740993'), 9007199254740993n);
  assert.equal(editor.parseValue('long', '9007199254740992'), 9007199254740992n);
  assert.equal(editor.parseValue('long', '9223372036854775807'), 9223372036854775807n);
  assert.equal(editor.parseValue('long', '-9223372036854775808'), -9223372036854775808n);
});

test('parseValue：long 拒绝越界与非十进制整数写法', () => {
  assert.throws(() => editor.parseValue('long', '9223372036854775808'), /超出 long 范围/);
  assert.throws(() => editor.parseValue('long', '-9223372036854775809'), /超出 long 范围/);
  assert.throws(() => editor.parseValue('long', '1e5'), /不是合法的 long/);
  assert.throws(() => editor.parseValue('long', '12.5'), /不是合法的 long/);
  assert.throws(() => editor.parseValue('long', '0x10'), /不是合法的 long/);
});
