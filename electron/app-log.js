'use strict';

/**
 * 启动器自己的日志文件。
 *
 * 之前主进程的输出只出现在启动终端里：窗口关闭后什么都没留下，崩溃窗口
 * 也就没有「打开日志文件夹」可指向的东西。这里把 console.* 与未捕获异常
 * 落盘到 <userData>/logs/launcher-YYYYMMDD.log，并给崩溃窗口 / 设置页
 * 提供 tail() 与路径查询。
 *
 * 约束：
 *   - 只写纯文本，不写任何账号令牌（调用方自己保证不打印敏感值）；
 *   - 任何 IO 失败都降级为「不落盘」，绝不影响启动器本身；
 *   - 单文件按天切分，超过 4 MB 时换一个带序号的文件，避免无限增长。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TAIL_LINES = 5000;

let logDir = '';
let currentFile = '';
let stream = null;
let initialized = false;

function pad(value) {
  return String(value).padStart(2, '0');
}

function dayStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function timeStamp(date = new Date()) {
  return `${dayStamp(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function logFileFor(dir) {
  const base = path.join(dir, `launcher-${dayStamp()}.log`);
  try {
    const stat = fs.statSync(base);
    if (stat.size < MAX_FILE_BYTES) return base;
    return path.join(dir, `launcher-${timeStamp()}.log`);
  } catch {
    return base;
  }
}

function safeString(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (value === undefined) return 'undefined';
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

function formatArgs(args) {
  return Array.prototype.map.call(args, safeString).join(' ');
}

function writeLine(level, text) {
  if (!stream) return;
  const line = `[${new Date().toISOString()}][${level}] ${String(text).replace(/\r?\n/g, '\n    ')}\n`;
  try {
    stream.write(line);
  } catch {
    // 磁盘满 / 权限变化：日志丢掉也不能影响运行
  }
}

/** 在 app ready 之前调用即可（只依赖 userData 路径）。 */
function init(userDataDir) {
  if (initialized) return logDir;
  if (!userDataDir) return '';

  logDir = path.join(userDataDir, 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
    currentFile = logFileFor(logDir);
    stream = fs.createWriteStream(currentFile, { flags: 'a' });
    stream.on('error', () => {
      // 写不进去就静默降级；不要把 console 再打一遍，避免递归
      stream = null;
    });
  } catch {
    logDir = '';
    stream = null;
  }

  initialized = true;

  // 包一层 console：主进程里现有的 console.log / warn / error 自动落盘。
  const originals = {
    log: console.log.bind(console),
    info: console.info ? console.info.bind(console) : console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  const wrap = (level, original) => function wrapped() {
    try {
      writeLine(level, formatArgs(arguments));
    } catch {
      // 忽略
    }
    return original.apply(console, arguments);
  };

  console.log = wrap('INFO', originals.log);
  console.info = wrap('INFO', originals.info);
  console.warn = wrap('WARN', originals.warn);
  console.error = wrap('ERROR', originals.error);

  writeLine('INFO', `log file: ${currentFile}`);
  return logDir;
}

function dir() {
  return logDir;
}

function file() {
  return currentFile;
}

/** 最近 n 行（默认 400）：崩溃窗口 / 日志窗口的兜底来源。 */
function tail(maxLines = 400) {
  const limit = Math.max(1, Math.min(MAX_TAIL_LINES, Number(maxLines) || 400));
  if (!currentFile) return '';
  try {
    const raw = fs.readFileSync(currentFile, 'utf8');
    const lines = raw.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-limit).join('\n');
  } catch {
    return '';
  }
}

/** 显式记一条（不需换算级别时用）。 */
function append(level, text) {
  writeLine(String(level || 'INFO').toUpperCase(), text);
}

module.exports = {
  init,
  dir,
  file,
  tail,
  append
};
