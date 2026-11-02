'use strict';

/**
 * 最小 NBT 读写（1.20 / level.dat 用得到的子集）。
 *
 * 只需要能整份读出来、改几个字段、再原样写回去，因此实现了全部 12 种 tag，
 * 但保留的是「类型 + 值」的轻量包装，配合 Map 保持字段顺序。
 */

const fs = require('node:fs/promises');
const zlib = require('node:zlib');

const { writeFileAtomic } = require('./atomic-write');

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

const TAG_NAMES = {
  0: 'end',
  1: 'byte',
  2: 'short',
  3: 'int',
  4: 'long',
  5: 'float',
  6: 'double',
  7: 'byteArray',
  8: 'string',
  9: 'list',
  10: 'compound',
  11: 'intArray',
  12: 'longArray'
};

class NbtError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NbtError';
  }
}

function isGzip(buffer) {
  return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  ensure(count) {
    if (this.offset + count > this.buffer.length) {
      throw new NbtError('NBT 数据不完整');
    }
  }

  u8() {
    this.ensure(1);
    return this.buffer.readUInt8(this.offset++);
  }

  i8() {
    this.ensure(1);
    return this.buffer.readInt8(this.offset++);
  }

  i16() {
    this.ensure(2);
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  u16() {
    this.ensure(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  i32() {
    this.ensure(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  u32() {
    this.ensure(4);
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  i64() {
    this.ensure(8);
    const value = this.buffer.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  f32() {
    this.ensure(4);
    const value = this.buffer.readFloatBE(this.offset);
    this.offset += 4;
    return value;
  }

  f64() {
    this.ensure(8);
    const value = this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }

  string() {
    const length = this.u16();
    this.ensure(length);
    const value = this.buffer.slice(this.offset, this.offset + length).toString('utf8');
    this.offset += length;
    return value;
  }

  payload(type) {
    switch (type) {
      case TAG_BYTE:
        return { type: 'byte', value: this.i8() };
      case TAG_SHORT:
        return { type: 'short', value: this.i16() };
      case TAG_INT:
        return { type: 'int', value: this.i32() };
      case TAG_LONG:
        return { type: 'long', value: this.i64() };
      case TAG_FLOAT:
        return { type: 'float', value: this.f32() };
      case TAG_DOUBLE:
        return { type: 'double', value: this.f64() };
      case TAG_BYTE_ARRAY: {
        const length = this.i32();
        if (length < 0) throw new NbtError('非法的 ByteArray 长度');
        this.ensure(length);
        const value = Buffer.from(this.buffer.slice(this.offset, this.offset + length));
        this.offset += length;
        return { type: 'byteArray', value };
      }
      case TAG_STRING:
        return { type: 'string', value: this.string() };
      case TAG_LIST: {
        const itemType = this.u8();
        const length = this.i32();
        if (length < 0) throw new NbtError('非法的 List 长度');
        const items = new Array(length);
        for (let index = 0; index < length; index += 1) {
          items[index] = this.payload(itemType);
        }
        return { type: 'list', itemType, value: items };
      }
      case TAG_COMPOUND: {
        const value = new Map();
        for (;;) {
          const childType = this.u8();
          if (childType === TAG_END) break;
          const name = this.string();
          value.set(name, this.payload(childType));
        }
        return { type: 'compound', value };
      }
      case TAG_INT_ARRAY: {
        const length = this.i32();
        if (length < 0 || length > 1e7) throw new NbtError('非法的 IntArray 长度');
        const values = new Array(length);
        for (let index = 0; index < length; index += 1) values[index] = this.i32();
        return { type: 'intArray', value: values };
      }
      case TAG_LONG_ARRAY: {
        const length = this.i32();
        if (length < 0 || length > 1e7) throw new NbtError('非法的 LongArray 长度');
        const values = new Array(length);
        for (let index = 0; index < length; index += 1) values[index] = this.i64();
        return { type: 'longArray', value: values };
      }
      default:
        throw new NbtError(`未知的 NBT tag 类型：${type}`);
    }
  }
}

function parse(buffer) {
  const reader = new Reader(buffer);
  const type = reader.u8();
  if (type !== TAG_COMPOUND) throw new NbtError('NBT 根节点不是 Compound');
  const name = reader.string();
  const tag = reader.payload(type);
  return { name, tag };
}

class Writer {
  constructor() {
    this.chunks = [];
  }

  push(buffer) {
    this.chunks.push(buffer);
  }

  i8(value) {
    const buffer = Buffer.alloc(1);
    buffer.writeInt8(value, 0);
    this.push(buffer);
  }

  i16(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeInt16BE(value, 0);
    this.push(buffer);
  }

  u16(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16BE(value, 0);
    this.push(buffer);
  }

  i32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value, 0);
    this.push(buffer);
  }

  i64(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(BigInt(value), 0);
    this.push(buffer);
  }

  f32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatBE(value, 0);
    this.push(buffer);
  }

  f64(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeDoubleBE(value, 0);
    this.push(buffer);
  }

  string(value) {
    const buffer = Buffer.from(String(value), 'utf8');
    this.u16(buffer.length);
    this.push(buffer);
  }

  payload(tag) {
    switch (tag.type) {
      case 'byte':
        this.i8(Number(tag.value) || 0);
        return;
      case 'short':
        this.i16(Number(tag.value) || 0);
        return;
      case 'int':
        this.i32(Number(tag.value) || 0);
        return;
      case 'long':
        this.i64(tag.value);
        return;
      case 'float':
        this.f32(Number(tag.value) || 0);
        return;
      case 'double':
        this.f64(Number(tag.value) || 0);
        return;
      case 'byteArray': {
        const buffer = Buffer.isBuffer(tag.value) ? tag.value : Buffer.from(tag.value || []);
        this.i32(buffer.length);
        this.push(buffer);
        return;
      }
      case 'string':
        this.string(tag.value || '');
        return;
      case 'list': {
        const items = Array.isArray(tag.value) ? tag.value : [];
        const itemType = tag.itemType || (items[0] ? typeByteOf(items[0]) : TAG_END);
        this.i8(itemType);
        this.i32(items.length);
        items.forEach((item) => this.payload(item));
        return;
      }
      case 'compound':
        for (const [name, child] of tag.value.entries()) {
          const childType = typeByteOf(child);
          this.i8(childType);
          this.string(name);
          this.payload(child);
        }
        this.i8(TAG_END);
        return;
      case 'intArray': {
        this.i32(tag.value.length);
        tag.value.forEach((value) => this.i32(Number(value) || 0));
        return;
      }
      case 'longArray': {
        this.i32(tag.value.length);
        tag.value.forEach((value) => this.i64(value));
        return;
      }
      default:
        throw new NbtError(`无法写入的 NBT tag 类型：${tag.type}`);
    }
  }

  concat() {
    return Buffer.concat(this.chunks);
  }
}

function typeByteOf(tag) {
  switch (tag && tag.type) {
    case 'byte': return TAG_BYTE;
    case 'short': return TAG_SHORT;
    case 'int': return TAG_INT;
    case 'long': return TAG_LONG;
    case 'float': return TAG_FLOAT;
    case 'double': return TAG_DOUBLE;
    case 'byteArray': return TAG_BYTE_ARRAY;
    case 'string': return TAG_STRING;
    case 'list': return TAG_LIST;
    case 'compound': return TAG_COMPOUND;
    case 'intArray': return TAG_INT_ARRAY;
    case 'longArray': return TAG_LONG_ARRAY;
    default: throw new NbtError(`未知的 NBT tag：${tag && tag.type}`);
  }
}

function serialize({ name = '', tag }) {
  const writer = new Writer();
  writer.i8(TAG_COMPOUND);
  writer.string(name || '');
  writer.payload(tag);
  return writer.concat();
}

async function readFile(file) {
  const raw = await fs.readFile(file);
  const buffer = isGzip(raw) ? zlib.gunzipSync(raw) : raw;
  return parse(buffer);
}

/** 写回 gzip 压缩的 level.dat（Minecraft 默认格式）。 */
async function writeFile(file, root) {
  const plain = serialize(root);
  const compressed = zlib.gzipSync(plain, { level: 6 });
  // 原子写：level.dat 写坏等于存档损坏；temp + fsync + rename 由 writeFileAtomic 统一负责。
  await writeFileAtomic(file, compressed);
}

// ---------------- 取值 / 赋值辅助 ----------------

function compoundOf(tag) {
  return tag && tag.type === 'compound' ? tag.value : null;
}

function get(root, ...keys) {
  let node = root && root.tag;
  for (const key of keys) {
    const map = compoundOf(node);
    if (!map) return undefined;
    node = map.get(key);
    if (!node) return undefined;
  }
  return node;
}

function getNumber(root, ...keys) {
  const node = get(root, ...keys);
  if (!node) return undefined;
  if (node.type === 'long') return Number(node.value);
  return Number(node.value);
}

function getLongString(root, ...keys) {
  const node = get(root, ...keys);
  if (!node) return '';
  return String(node.value);
}

function getString(root, ...keys) {
  const node = get(root, ...keys);
  return node && node.type === 'string' ? node.value : '';
}

function getBoolean(root, ...keys) {
  return getNumber(root, ...keys) === 1;
}

function setNumber(root, type, value, ...keys) {
  let map = compoundOf(root.tag);
  if (!map) throw new NbtError('根节点不是 Compound');
  for (let index = 0; index < keys.length - 1; index += 1) {
    let next = map.get(keys[index]);
    if (!next || next.type !== 'compound') {
      next = { type: 'compound', value: new Map() };
      map.set(keys[index], next);
    }
    map = next.value;
  }
  map.set(keys[keys.length - 1], { type, value });
}

function setByte(root, value, ...keys) {
  const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : (Number(value) || 0);
  setNumber(root, 'byte', numeric, ...keys);
}

function setInt(root, value, ...keys) {
  setNumber(root, 'int', Number(value) || 0, ...keys);
}

function setLong(root, value, ...keys) {
  setNumber(root, 'long', BigInt(value), ...keys);
}

function setString(root, value, ...keys) {
  let map = compoundOf(root.tag);
  if (!map) throw new NbtError('根节点不是 Compound');
  for (let index = 0; index < keys.length - 1; index += 1) {
    let next = map.get(keys[index]);
    if (!next || next.type !== 'compound') {
      next = { type: 'compound', value: new Map() };
      map.set(keys[index], next);
    }
    map = next.value;
  }
  map.set(keys[keys.length - 1], { type: 'string', value: String(value) });
}

module.exports = {
  TAG_NAMES,
  NbtError,
  isGzip,
  parse,
  serialize,
  readFile,
  writeFile,
  get,
  getNumber,
  getLongString,
  getString,
  getBoolean,
  setNumber,
  setByte,
  setInt,
  setLong,
  setString,
  compoundOf
};
