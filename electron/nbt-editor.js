'use strict';

/**
 * NBT 编辑器（设置 → 通用 → NBT 编辑器）。
 *
 * 目标不是做一个通用 NBT IDE，而是「能看见整棵树、能改标量字段、能原样写回」：
 *   - 读取：复用 nbt.js 的 12 种 tag 解析，未知字段不动；
 *   - 展示：把 compound / list 展平成 [路径, 类型, 值] 的行，标量可编辑；
 *   - 写回：按路径定位到 tag 后就地替换值（类型按原 tag 保留），
 *          写之前把原文件复制成 `<文件>.bak`，并用临时文件 + rename 落盘。
 *
 * 不提供「新增 / 删除节点」：那要连带处理父类型、列表 itemType、长度等约束，
 * 误操作代价远高于收益，本版只做字段编辑。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const nbt = require('./nbt');

const MAX_ROWS = 4000;
const MAX_DEPTH = 16;
const EDITABLE = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'string']);
const MAX_VALUE_LENGTH = 4096;
// long 用 BigInt 表示；这两个边界给 parseValue 做范围校验（NBT long 是 64 位有符号）。
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

function stringifyValue(tag) {
  if (!tag) return '';
  if (tag.type === 'long') return String(tag.value);
  if (tag.type === 'byteArray') return `[${tag.value.length} 字节]`;
  if (tag.type === 'intArray') return `[${tag.value.length} 个整数]`;
  if (tag.type === 'longArray') return `[${tag.value.length} 个长整数]`;
  if (tag.type === 'list') return `[${tag.value.length} 项 ${nbt.TAG_NAMES[tag.itemType] || ''}]`;
  return String(tag.value);
}

function flatten(rootTag) {
  const rows = [];
  let truncated = false;

  const walk = (tag, route, label) => {
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      return;
    }
    if (!tag) return;

    if (tag.type === 'compound') {
      for (const [name, child] of tag.value.entries()) {
        if (rows.length >= MAX_ROWS) {
          truncated = true;
          return;
        }
        if (child.type === 'compound' || child.type === 'list') {
          if (route.length >= MAX_DEPTH) {
            rows.push({ path: route.concat(name), depth: route.length, type: child.type, value: '（层级过深，已省略）', editable: false });
            continue;
          }
          rows.push({
            path: route.concat(name),
            depth: route.length,
            type: child.type,
            value: stringifyValue(child),
            editable: false
          });
          walk(child.value ? child : null, route.concat(name), name);
          if (child.type === 'list') walkList(child, route.concat(name));
          continue;
        }
        rows.push({
          path: route.concat(name),
          depth: route.length,
          type: child.type,
          value: stringifyValue(child),
          editable: EDITABLE.has(child.type)
        });
      }
      return;
    }
  };

  const walkList = (list, route) => {
    if (!Array.isArray(list.value)) return;
    // 只有「列表里还是 compound」才值得展开；标量列表用长度展示即可。
    if (list.itemType !== 10 && list.itemType !== 9) return;
    list.value.forEach((item, index) => {
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        return;
      }
      rows.push({
        path: route.concat(String(index)),
        depth: route.length,
        type: item.type,
        value: stringifyValue(item),
        editable: false
      });
      if (item.type === 'compound') walk(item, route.concat(String(index)));
      else if (item.type === 'list') walkList(item, route.concat(String(index)));
    });
  };

  if (rootTag.type === 'compound') walk(rootTag, []);
  return { rows, truncated };
}

/** 按路径找 tag；路径段是 compound 的字段名或 list 的下标。 */
function resolveTag(root, route) {
  let node = root.tag;
  for (const key of route) {
    if (!node) return null;
    if (node.type === 'compound') {
      node = node.value.get(key);
      continue;
    }
    if (node.type === 'list') {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= node.value.length) return null;
      node = node.value[index];
      continue;
    }
    return null;
  }
  return node || null;
}

function parseValue(type, raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text.length > MAX_VALUE_LENGTH) throw new Error('值太长（上限 4096 字符）');

  switch (type) {
    case 'string':
      return text;
    case 'byte': {
      const number = Number(text);
      if (!Number.isInteger(number) || number < -128 || number > 127) {
        throw new Error(`${text} 不是合法的 byte（-128 ~ 127）`);
      }
      return number;
    }
    case 'short': {
      const number = Number(text);
      if (!Number.isInteger(number) || number < -32768 || number > 32767) {
        throw new Error(`${text} 不是合法的 short（-32768 ~ 32767）`);
      }
      return number;
    }
    case 'int': {
      const number = Number(text);
      if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) {
        throw new Error(`${text} 不是合法的 int`);
      }
      return number;
    }
    case 'long': {
      // 必须按十进制整数直接转 BigInt：经 Number 中转会在 2^53 之上丢精度，
      // 而 RandomSeed 这类字段很容易超过 2^53，静默改掉玩家种子是不可接受的。
      if (!/^-?\d+$/.test(text)) {
        throw new Error(`${text} 不是合法的 long（需要十进制整数）`);
      }
      const value = BigInt(text);
      if (value < LONG_MIN || value > LONG_MAX) {
        throw new Error(`${text} 超出 long 范围（-2^63 ~ 2^63-1）`);
      }
      return value;
    }
    case 'float':
    case 'double': {
      const number = Number(text);
      if (!Number.isFinite(number)) throw new Error(`${text} 不是合法的数字`);
      return number;
    }
    default:
      throw new Error(`类型 ${type} 不支持编辑`);
  }
}

/**
 * 读文件并返回可编辑的行。
 * @returns {Promise<{name:string, size:number, rows:Array, truncated:boolean}>}
 */
async function load(file) {
  const stat = await fs.stat(file);
  const root = await nbt.readFile(file);
  const { rows, truncated } = flatten(root.tag);
  return { name: root.name || '', size: stat.size, rows, truncated };
}

/**
 * 应用一批改动并写回。
 * @param {string} file
 * @param {Array<{path:string[], value:string}>} edits
 */
async function save(file, edits) {
  const list = Array.isArray(edits) ? edits : [];
  if (list.length === 0) throw new Error('没有要保存的改动');
  if (list.length > 4000) throw new Error('改动项过多');

  const root = await nbt.readFile(file);
  const applied = [];

  for (const edit of list) {
    if (!edit || !Array.isArray(edit.path) || edit.path.length === 0) continue;
    const route = edit.path.map(String);
    const tag = resolveTag(root, route);
    if (!tag) throw new Error(`找不到字段：${route.join('.')}`);
    if (!EDITABLE.has(tag.type)) throw new Error(`字段 ${route.join('.')} 不是可编辑的标量类型`);

    const next = parseValue(tag.type, edit.value);
    if (tag.type === 'long') tag.value = BigInt(next);
    else tag.value = next;
    applied.push({ path: route.join('.'), type: tag.type, value: String(next) });
  }

  if (applied.length === 0) throw new Error('没有有效改动');

  // 覆盖前留一份原文件；Minecraft 自己也是这么干的。
  await fs.copyFile(file, `${file}.bak`).catch(() => {});
  await nbt.writeFile(file, root);

  const stat = await fs.stat(file);
  return { file, size: stat.size, applied };
}

module.exports = {
  EDITABLE,
  load,
  save,
  flatten,
  resolveTag,
  parseValue
};
