'use strict';

/**
 * 测试用 zip 构造器（STORE，不压缩）。
 *
 * poc.js 用它造"含 .. 条目 / 符号链接条目"的恶意整合包，
 * runtime-check.js 用它造"合法整合包"做功能冒烟。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * @param {Array<{name:string, data?:string|Buffer, unixMode?:number}>} entries
 *   unixMode 例如 0o120777 表示符号链接条目
 * @returns {Buffer}
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data || '');
    const crc = crc32(data);
    const mode = entry.unixMode || 0o100644;
    const madeBy = entry.unixMode ? (3 << 8) | 20 : (0 << 8) | 20;
    const external = (mode << 16) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(madeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(external, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/** 写一个合法整合包（带 modrinth 清单），返回绝对路径。 */
async function writeGoodPack(dir, name = 'good.zip') {
  const file = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, buildZip([
    { name: 'modrinth.index.json', data: JSON.stringify({ name: 'smoke', files: [] }) },
    { name: 'overrides/config/smoke.txt', data: 'hello' }
  ]));
  return file;
}

module.exports = { buildZip, writeGoodPack };
