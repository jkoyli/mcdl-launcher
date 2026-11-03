'use strict';

/**
 * mcdl 子进程输出编码回归测试。
 *
 * 背景（v0.3.1 实测）：
 *   JDK 18 起 `-Dfile.encoding=UTF-8` 不再决定重定向到管道时的 System.out 编码，
 *   它由 `-Dstdout.encoding` 控制，默认取系统本地编码 —— 中文 Windows 上就是 GBK。
 *   mcdl 的版本表格是中文表头 + 中文类型标签，用 UTF-8 去解 GBK 会得到一堆
 *   U+FFFD，listVersions 的正则 0 命中 → 「mcdl 没有返回可解析的版本列表」。
 *
 * 这里锁三层：
 *   1. runMcdl 给 JVM 的参数必须同时覆盖 file.encoding 和 stdout/stderr.encoding；
 *   2. 解码器能认出 UTF-8 / GBK / UTF-16LE / UTF-16BE（含流式 chunk 切分）；
 *   3. 解出来的文本能被版本表解析器正确解析（这才是最终目的）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mcdl = require('../mcdl-service');

// 下面这段文本的真实 CP936 字节（由 PowerShell 的 Encoding.GetEncoding(936) 生成，
// 不是手写常量）。内容与 mcdl --list 的输出形状一致。
const GBK_HEX =
  'D7EED0C2D5FDCABDB0E6A3BA312E32312E3820202020D7EED0C2BFECD5D5A3BA3235773331610D0A' +
  '312E32312E382020202020202020202020202020D5FDCABDB0E6202020202020323032352D30372D31370D0A' +
  '3235773331612020202020202020202020202020BFECD5D52020202020202020323032352D30372D32390D0A' +
  '312E31342E32205072652D52656C6561736520342020BFECD5D5202020202020323031392D30352D31330D0A' +
  '312E302020202020202020202020202020202020D4B6B9C520416C706861202020323031302D30362D33300D0A';

const TABLE_TEXT =
  '最新正式版：1.21.8    最新快照：25w31a\r\n' +
  '1.21.8              正式版      2025-07-17\r\n' +
  '25w31a              快照        2025-07-29\r\n' +
  '1.14.2 Pre-Release 4  快照      2019-05-13\r\n' +
  '1.0                 远古 Alpha   2010-06-30\r\n';

const GBK_TABLE = Buffer.from(GBK_HEX, 'hex');

test('JVM 参数同时设置 file.encoding 与 stdout/stderr.encoding', () => {
  // JDK 17 只认 file.encoding；JDK 18+ 只认 stdout/stderr.encoding。
  assert.ok(mcdl.MCDL_JVM_OPTS.includes('-Dfile.encoding=UTF-8'));
  assert.ok(mcdl.MCDL_JVM_OPTS.includes('-Dstdout.encoding=UTF-8'));
  assert.ok(mcdl.MCDL_JVM_OPTS.includes('-Dstderr.encoding=UTF-8'));
});

test('decodeMcdlOutput：UTF-8 原样解出', () => {
  const result = mcdl.decodeMcdlOutput(Buffer.from(TABLE_TEXT, 'utf8'));
  assert.equal(result.encoding, 'utf-8');
  assert.equal(result.text, TABLE_TEXT);
});

test('decodeMcdlOutput：中文 Windows 的 GBK 输出能解成正确中文', () => {
  const result = mcdl.decodeMcdlOutput(GBK_TABLE);
  assert.equal(result.encoding, 'gb18030');
  assert.equal(result.text, TABLE_TEXT);
});

test('decodeMcdlOutput：UTF-16LE（带 BOM）', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TABLE_TEXT, 'utf16le')]);
  const result = mcdl.decodeMcdlOutput(buf);
  assert.equal(result.encoding, 'utf-16le');
  assert.equal(result.text, TABLE_TEXT);
});

test('decodeMcdlOutput：UTF-16LE（无 BOM，实测出现过的形态）', () => {
  const result = mcdl.decodeMcdlOutput(Buffer.from(TABLE_TEXT, 'utf16le'));
  assert.equal(result.encoding, 'utf-16le');
  assert.equal(result.text, TABLE_TEXT);
});

test('decodeMcdlOutput：UTF-16BE（带 BOM）', () => {
  const body = Buffer.from(TABLE_TEXT, 'utf16le');
  body.swap16();
  const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
  const result = mcdl.decodeMcdlOutput(buf);
  assert.equal(result.encoding, 'utf-16be');
  assert.equal(result.text, TABLE_TEXT);
});

test('流式解码：GBK 被切成 1 字节一个 chunk 也不出错', () => {
  const decoder = mcdl.createOutputDecoder();
  let text = '';
  for (const byte of GBK_TABLE) {
    text += decoder.push(Buffer.from([byte]));
  }
  text += decoder.end();
  assert.equal(decoder.encoding, 'gb18030');
  assert.equal(text, TABLE_TEXT);
});

test('流式解码：UTF-8 多字节字符被切在两个 chunk 中间', () => {
  const buf = Buffer.from(TABLE_TEXT, 'utf8');
  // 「最」是 3 字节，切在它中间；且开头一段没有换行，走「攒够再判断」的分支。
  const cut = 2;
  const decoder = mcdl.createOutputDecoder();
  const first = decoder.push(buf.subarray(0, cut));
  const second = decoder.push(buf.subarray(cut));
  const tail = decoder.end();
  assert.equal(first + second + tail, TABLE_TEXT);
});

test('流式解码：首个 chunk 没有换行时不会过早判成 GBK', () => {
  const buf = Buffer.from('正在获取版本清单…', 'utf8');
  const decoder = mcdl.createOutputDecoder();
  // 只有 3 个字节，且没有换行 → 先不判，返回空串。
  assert.equal(decoder.push(buf.subarray(0, 3)), '');
  assert.equal(decoder.push(buf.subarray(3)) + decoder.end(), '正在获取版本清单…');
});

test('parseVersionTable：GBK 解出来的表格能解析出版本 + 最新正式版/快照', () => {
  const { text } = mcdl.decodeMcdlOutput(GBK_TABLE);
  const parsed = mcdl.parseVersionTable(text);

  assert.equal(parsed.latestRelease, '1.21.8');
  assert.equal(parsed.latestSnapshot, '25w31a');
  assert.deepEqual(
    parsed.versions.map((version) => [version.id, version.type, version.date]),
    [
      ['1.21.8', 'release', '2025-07-17'],
      ['25w31a', 'snapshot', '2025-07-29'],
      // 版本 ID 里带空格的情况不能按第一个空格切
      ['1.14.2 Pre-Release 4', 'snapshot', '2019-05-13'],
      ['1.0', 'old', '2010-06-30']
    ]
  );
});

test('parseVersionTable：空输出/无关输出不会抛错，只是 0 个版本', () => {
  assert.deepEqual(mcdl.parseVersionTable(''), {
    versions: [],
    latestRelease: '',
    latestSnapshot: ''
  });
  assert.equal(mcdl.parseVersionTable('网络错误：连接超时').versions.length, 0);
});
