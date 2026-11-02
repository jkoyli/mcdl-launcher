'use strict';

/**
 * 启动前完整性闸门 + 缺失文件修复。
 *
 * 背景（PCL2 的历史 bug）：关键文件下载失败后仍然拉起游戏，Java 拿着残缺的
 * classpath 启动 → 游戏侧崩溃 → 用户只看到「闪退」。正确的做法是在 spawn 之前
 * 就把「必需文件是否齐全」判定完，缺什么就显式中止并说出缺什么。
 *
 * 这一层只认结构化的文件清单（buildLaunchPlan 产出的 plan.requiredFiles），
 * 好处是：
 *   - 校验与「修复」用同一份清单，不会各解析一遍版本 JSON 后口径不一致；
 *   - 失败结果是数据（missing / corrupt 数组），不是一句拼好的字符串，
 *     UI 可以逐条展示，也能据此定向重新下载。
 *
 * 校验策略（hashCheck）：
 *   - 'auto'（默认）：只对体量小、坏了最致命的那几个文件算 SHA-1
 *     （客户端 jar、资源索引、log4j 配置、authlib-injector）；
 *     依赖库 / natives 只查存在与非空——每次启动给几百 MB 的 libraries 算哈希
 *     会把启动时间拖到不可接受。
 *   - true：所有带 sha1 的条目都算。
 *   - false：只查存在与非空。
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');

const { writeFileAtomic } = require('./atomic-write');

const KIND_LABELS = {
  client: '客户端 jar',
  library: '依赖库',
  native: 'natives 包',
  assetsIndex: '资源索引',
  logConfig: '日志配置',
  authlib: 'authlib-injector'
};

/** 默认就算哈希的种类：小文件，且坏了必然启动失败。 */
const HASH_ALWAYS_KINDS = new Set(['client', 'assetsIndex', 'authlib', 'logConfig']);

const DOWNLOAD_TIMEOUT_MS = 60000;
const REPAIR_CONCURRENCY = 4;

function kindLabel(kind) {
  return KIND_LABELS[kind] || '文件';
}

function shortPath(file, baseDir) {
  const resolved = path.resolve(file);
  if (!baseDir) return resolved;
  const relative = path.relative(path.resolve(baseDir), resolved);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : resolved;
}

function fileEntryLabel(entry, baseDir) {
  const name = entry && entry.name ? String(entry.name) : path.basename(String(entry && entry.path));
  return `${kindLabel(entry && entry.kind)} ${name}`;
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function statFile(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return { exists: false, isFile: false, size: 0 };
    return { exists: true, isFile: true, size: stat.size };
  } catch {
    return { exists: false, isFile: false, size: 0 };
  }
}

function shouldHash(entry, hashCheck) {
  if (hashCheck === false) return false;
  if (hashCheck === true) return Boolean(entry && entry.sha1);
  if (!entry || !entry.sha1) return false;
  return HASH_ALWAYS_KINDS.has(entry.kind);
}

/**
 * 校验一份文件清单。
 *
 * @param {Array<{path:string,kind:string,name?:string,sha1?:string,size?:number,url?:string,optional?:boolean}>} files
 * @param {{hashCheck?:boolean|'auto', baseDir?:string, onProgress?:(message:string)=>void}} [options]
 * @returns {Promise<{
 *   ok:boolean, checked:number,
 *   missing:Array<object>, corrupt:Array<object>, optionalMissing:Array<object>
 * }>}
 */
async function verifyRequiredFiles(files, options = {}) {
  const list = Array.isArray(files) ? files : [];
  const hashCheck = options.hashCheck === undefined ? 'auto' : options.hashCheck;
  const baseDir = options.baseDir || '';
  const missing = [];
  const corrupt = [];
  const optionalMissing = [];
  let hashed = 0;

  for (const entry of list) {
    if (!entry || typeof entry.path !== 'string' || !entry.path) continue;

    const stat = await statFile(entry.path);
    const described = {
      path: entry.path,
      relative: shortPath(entry.path, baseDir),
      kind: entry.kind || 'library',
      label: fileEntryLabel(entry, baseDir),
      reason: '',
      expectedSize: Number(entry.size) || 0,
      actualSize: stat.size,
      // 修复要靠这两个字段：没有它们就只能盲下，等于把校验又关掉了。
      sha1: typeof entry.sha1 === 'string' ? entry.sha1 : '',
      url: typeof entry.url === 'string' ? entry.url : ''
    };

    if (!stat.exists || !stat.isFile) {
      described.reason = 'missing';
      (entry.optional ? optionalMissing : missing).push(described);
      continue;
    }

    if (!entry.optional && (stat.size === 0 || (described.expectedSize > 0 && stat.size !== described.expectedSize))) {
      described.reason = stat.size === 0 ? 'empty' : 'size';
      corrupt.push(described);
      continue;
    }

    if (shouldHash(entry, hashCheck)) {
      hashed += 1;
      let actual = '';
      try {
        actual = await sha1File(entry.path);
      } catch (error) {
        described.reason = 'unreadable';
        described.error = error && error.message ? error.message : String(error);
        corrupt.push(described);
        continue;
      }
      if (actual.toLowerCase() !== String(entry.sha1).toLowerCase()) {
        described.reason = 'hash';
        described.expectedSha1 = String(entry.sha1).toLowerCase();
        described.actualSha1 = actual.toLowerCase();
        corrupt.push(described);
      }
    }
  }

  return {
    ok: missing.length === 0 && corrupt.length === 0,
    checked: list.length,
    hashed,
    missing,
    corrupt,
    optionalMissing
  };
}

const REASON_TEXT = {
  missing: '缺失',
  empty: '文件是空的',
  size: '大小不符',
  hash: '校验和不符',
  unreadable: '读取失败'
};

/** 把一条失败记录变成人能读的一行。 */
function describeFailure(item) {
  const reason = REASON_TEXT[item && item.reason] || '有问题';
  let detail = reason;
  if (item && item.reason === 'size') {
    detail = `${reason}（期望 ${item.expectedSize} 字节，实际 ${item.actualSize} 字节）`;
  } else if (item && item.reason === 'hash') {
    detail = `${reason}（期望 ${String(item.expectedSha1).slice(0, 8)}…，实际 ${String(item.actualSha1).slice(0, 8)}…）`;
  } else if (item && item.reason === 'unreadable' && item.error) {
    detail = `${reason}：${item.error}`;
  }
  const label = (item && item.label) || kindLabel(item && item.kind);
  const where = item && item.relative ? `（${item.relative}）` : '';
  return `${label}${where} — ${detail}`;
}

/**
 * 把校验结果变成「可以直接展示 + 可以直接 throw」的结构。
 * message 的第一行是结论，第二行是用户能执行的动作。
 */
function summarizePreflight(result) {
  const failures = [...(result.missing || []), ...(result.corrupt || [])];
  const count = failures.length;
  const preview = failures.slice(0, 5).map(describeFailure);
  const more = count > preview.length ? [`…另有 ${count - preview.length} 项`] : [];

  return {
    message: [
      `实例文件不完整，已中止启动（没有拉起 Java）。缺少或不一致 ${count} 项：`,
      ...preview,
      ...more,
      '可以在下方点「修复缺失文件」重新下载，或到实例管理里重新安装该版本。'
    ].join('\n'),
    failures: failures.map((item) => ({
      ...item,
      description: describeFailure(item)
    })),
    count
  };
}

/**
 * 下载一条缺失 / 损坏的记录。先校验、再用原子写落盘，
 * 避免又一次「中断后留下半个文件，下次还认为它存在」。
 */
async function downloadEntry(entry) {
  if (!entry || !entry.url) {
    throw new Error('这条记录没有下载地址，无法自动修复');
  }
  const target = entry.path;
  // 保留原有的「先建目录」副作用：即便这次下载/校验失败，目标目录也会被建好，
  // 上层（以及既有测试）会据此判断实例的目录结构。
  await fs.mkdir(path.dirname(target), { recursive: true });

  const response = await fetch(entry.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (entry.size > 0 && buffer.length !== entry.size) {
    throw new Error(`大小不符（期望 ${entry.size}，实际 ${buffer.length}）`);
  }
  if (entry.sha1) {
    const actual = crypto.createHash('sha1').update(buffer).digest('hex');
    if (actual.toLowerCase() !== String(entry.sha1).toLowerCase()) {
      throw new Error('SHA-1 校验失败，可能被劫持或缓存了旧文件');
    }
  }

  // 校验通过才落盘；writeFileAtomic 负责同目录临时文件 + fsync + rename，失败时目标保持原样。
  await writeFileAtomic(target, buffer);
}

async function runLimited(items, limit, worker) {
  const queue = items.slice();
  const errors = [];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        await worker(item);
      } catch (error) {
        errors.push({ item, error });
      }
    }
  });
  await Promise.all(runners);
  return errors;
}

/**
 * 修复缺失 / 损坏的文件。只处理清单里带 url 的条目，
 * 没有 url 的（例如整合包手工放的 jar）会留在 failed 里让 UI 说清楚。
 *
 * @returns {Promise<{repaired:Array<object>, failed:Array<{item:object,message:string}>, skipped:Array<object>}>}
 */
async function repairRequiredFiles(result, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const failures = [...(result && result.missing ? result.missing : []),
    ...(result && result.corrupt ? result.corrupt : [])];

  const downloadable = failures.filter((item) => item.url);
  const skipped = failures.filter((item) => !item.url);
  const repaired = [];

  if (downloadable.length > 0) onProgress(`正在重新下载 ${downloadable.length} 个文件…`);

  const errors = await runLimited(downloadable, REPAIR_CONCURRENCY, async (item) => {
    await downloadEntry(item);
    repaired.push(item);
    onProgress(`已修复 ${item.label}`);
  });

  return {
    repaired,
    failed: errors.map(({ item, error }) => ({
      item,
      message: error && error.message ? error.message : String(error)
    })),
    skipped
  };
}

module.exports = {
  KIND_LABELS,
  kindLabel,
  sha1File,
  verifyRequiredFiles,
  summarizePreflight,
  repairRequiredFiles,
  describeFailure,
  downloadEntry
};
