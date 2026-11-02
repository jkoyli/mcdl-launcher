'use strict';

/**
 * 实例合并（「更新整合包」）：把新整合包解出来的临时实例覆盖进用户实例。
 *
 * 为什么不能原地 copyFile：PCL2 曾经因为「解压时直接覆盖同名文件」的缺陷，
 * 在游戏占用文件 / 磁盘满 / 用户取消 / 进程被杀之后把用户的 mods、config 写成
 * 半新半旧，且没有任何回滚手段。这里用三步换掉整个实例目录：
 *
 *   1) target            → target.merge-<token>.tmp   （同父目录，同分区）
 *   2) 把 staging 覆盖进 tmp
 *   3) target → .old，tmp → target（两次 rename 都是同一分区内的原子操作）
 *   4) 成功后删 .old；失败按 .old 改回去
 *
 * 好处：在最坏的情况下（步骤 3 和 4 之间崩溃），磁盘上要么是完整的旧实例，
 * 要么是完整的新实例，外加一个 `.old` 目录——绝不会出现半覆盖的实例目录。
 * 临时目录名以 `.` 开头，`mcdl-service.scanInstances` / `instance-store` 的扫描
 * 都会跳过 `.` 开头的目录，所以不会被误识别成实例。
 *
 * 另外在动手之前，把所有「将被覆盖的文件」复制到实例目录**之外**的备份目录
 * （`<userData>/instance-merge-backups/…`），供用户事后「撤销本次更新」。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomic } = require('./atomic-write');

/** 备份清单格式版本：结构变了就 +1，读旧清单时直接拒绝而不是误删。 */
const MANIFEST_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
/** 备份里的文件树放在这个子目录，避免和实例里真实存在的 manifest.json 撞名。 */
const FILES_DIR = 'files';
/** 影子 / 回退目录的标记，配合 `.` 前缀确保扫描逻辑忽略它们。 */
const MERGE_MARKER = '.mcdl-merge';
const MAX_WALK_DEPTH = 32;

/**
 * 每个实例保留几份合并备份（只留最近的）。
 * 做成常量而不是散落的魔法数字：以后加设置项时只改这里的默认值。
 */
const KEEP_BACKUPS = 3;

/**
 * 合并备份目录名的形状：`new Date().toISOString().replace(/[:.]/g, '-')`，
 * 例如 2025-08-14T12-34-56-789Z。不匹配的一律不删（可能是用户自己放的东西）。
 */
const BACKUP_STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/**
 * 合并残留目录名的形状，必须和 mergeWithBackup 里的模板严格一致：
 *   `.<实例名>.` + `.mcdl-merge-<token>` + `.tmp` / `.old`
 * 也就是 `.my-pack..mcdl-merge-<token>.old`。只认这一种，别的一律不碰。
 */
const MERGE_LEFTOVER_PATTERN = new RegExp(
  `^\\.(.+?)\\.${MERGE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([A-Za-z0-9_-]+)\\.(tmp|old)$`
);

// ---------------- 路径与遍历 ----------------

/**
 * 相对路径统一用 `/` 存放（清单可读、跨平台一致），使用前再过一次越界校验。
 * 备份清单来自磁盘，是被丢弃/篡改后可能指向实例外的输入，所以每一次都要验。
 */
function assertSafeRel(rel) {
  const text = String(rel == null ? '' : rel);
  if (!text) throw new Error('合并清单里有空路径');
  if (path.isAbsolute(text) || /^[a-zA-Z]:/.test(text)) {
    throw new Error(`合并清单路径非法：${text}`);
  }
  const normalized = path.normalize(text);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
    throw new Error(`合并清单路径越界：${text}`);
  }
  return text;
}

function joinRel(root, rel) {
  assertSafeRel(rel);
  return path.join(root, ...String(rel).split('/'));
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 遍历目录：返回 `{ rel, kind: 'dir'|'file'|'link' }` 列表。
 * 目录符号链接不递归（防环），按 link 记录，由复制方决定要不要重建。
 */
async function walkTree(root) {
  const entries = [];
  const base = path.resolve(root);

  async function walk(absDir, relDir, depth) {
    if (depth > MAX_WALK_DEPTH) return;
    let dirents = [];
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      const abs = path.join(absDir, dirent.name);

      if (dirent.isSymbolicLink()) {
        let linkTarget = '';
        let linkIsDir = false;
        try {
          linkTarget = await fs.readlink(abs);
          linkIsDir = (await fs.stat(abs)).isDirectory();
        } catch {
          continue;
        }
        entries.push({ rel, kind: 'link', linkTarget, linkIsDir });
        continue;
      }
      if (dirent.isDirectory()) {
        entries.push({ rel, kind: 'dir' });
        await walk(abs, rel, depth + 1);
      } else if (dirent.isFile()) {
        entries.push({ rel, kind: 'file' });
      }
    }
  }

  await walk(base, '', 0);
  return entries;
}

/**
 * staging 里哪些文件不该合并进目标实例：
 *   - `versions/<id>/<id>.json` / `<id>.jar` 是版本元数据（复制过去只会留下垃圾文件）；
 *   - 顶层 `.mcdl-*`（安装断点状态等）是启动器自己的状态，不属于整合包内容。
 */
function isSkippedSourceFile(rel, sourceNameLower) {
  const text = String(rel || '');
  if (!text || text.includes('/')) return false;
  const lower = text.toLowerCase();
  if (lower.startsWith('.mcdl-')) return true;
  const base = String(sourceNameLower || '').toLowerCase();
  if (!base) return false;
  return lower === `${base}.json` || lower === `${base}.jar`;
}

// ---------------- 规划 ----------------

/**
 * 只读地算出「哪些文件会被覆盖 / 哪些是新增 / 哪些跳过」，不碰目标实例。
 *
 * @param {object} options
 * @param {string} options.sourceDir  新整合包解出来的临时实例目录
 * @param {string} options.targetDir  要被更新的实例目录
 * @param {string} [options.sourceName] 临时实例的文件夹名（默认取 sourceDir 的 basename）
 * @returns {Promise<{sourceDir:string,targetDir:string,sourceName:string,
 *   overwrite:string[],create:string[],skipped:string[]}>} 相对路径（`/` 分隔）
 */
async function planMerge({ sourceDir, targetDir, sourceName } = {}) {
  if (!sourceDir || !targetDir) throw new Error('合并需要源目录和目标目录');

  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  if (source === target) throw new Error('不能把整合包合并到它自己');

  const name = String(sourceName || path.basename(source));
  const entries = await walkTree(source);
  const overwrite = [];
  const create = [];
  const skipped = [];

  for (const entry of entries) {
    if (entry.kind === 'dir') continue;
    if (entry.kind === 'link' || isSkippedSourceFile(entry.rel, name)) {
      skipped.push(entry.rel);
      continue;
    }
    if (await pathExists(joinRel(target, entry.rel))) overwrite.push(entry.rel);
    else create.push(entry.rel);
  }

  overwrite.sort();
  create.sort();
  skipped.sort();

  return { sourceDir: source, targetDir: target, sourceName: name, overwrite, create, skipped };
}

// ---------------- 复制 ----------------

function cancellationChecker(options) {
  return () => {
    const signal = options && options.signal;
    if (signal && signal.aborted) return true;
    if (options && typeof options.isCancelled === 'function' && options.isCancelled()) return true;
    return false;
  };
}

function makeCancelledError() {
  const error = new Error('已取消');
  error.cancelled = true;
  error.code = 'TASK_CANCELLED';
  return error;
}

function isAbortError(error) {
  return Boolean(error && (error.cancelled || error.name === 'AbortError' || error.code === 'TASK_CANCELLED'));
}

async function callCopyHook(hooks, payload) {
  if (!hooks || typeof hooks.onBeforeCopy !== 'function') return;
  await hooks.onBeforeCopy(payload);
}

/**
 * 复制目录树（保留空目录；符号链接尽量重建，重建不了的文件退回复制内容）。
 * 只用于把「目标实例」复制成影子目录，所以不改动任何源文件。
 */
async function copyTreeTo(sourceDir, destDir, { phase = 'shadow', hooks = null, isCancelled = null, onFile = null } = {}) {
  const entries = await walkTree(sourceDir);
  await fs.mkdir(destDir, { recursive: true });

  const stats = { files: 0, bytes: 0 };
  for (const entry of entries) {
    if (isCancelled && isCancelled()) throw makeCancelledError();

    const to = joinRel(destDir, entry.rel);
    if (entry.kind === 'dir') {
      await fs.mkdir(to, { recursive: true });
      continue;
    }
    if (entry.kind === 'link') {
      await fs.mkdir(path.dirname(to), { recursive: true });
      try {
        await fs.symlink(entry.linkTarget, to, entry.linkIsDir ? 'junction' : 'file');
      } catch {
        // Windows 默认不允许普通用户建符号链接：文件退回复制内容，目录只能跳过。
        if (!entry.linkIsDir) {
          const from = joinRel(sourceDir, entry.rel);
          await fs.copyFile(from, to);
          const info = await fs.stat(from).catch(() => null);
          stats.files += 1;
          stats.bytes += info ? info.size : 0;
        }
      }
      continue;
    }

    const from = joinRel(sourceDir, entry.rel);
    await callCopyHook(hooks, { phase, rel: entry.rel, from, to });
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    const info = await fs.stat(from).catch(() => null);
    stats.files += 1;
    stats.bytes += info ? info.size : 0;
    if (onFile) onFile({ rel: entry.rel, files: stats.files, bytes: stats.bytes });
  }

  return stats;
}

/** 把 staging 覆盖进影子目录（跳过版本元数据）。 */
async function overlayInto({ sourceDir, destDir, sourceName, hooks, isCancelled, onFile }) {
  const entries = await walkTree(sourceDir);
  const stats = { files: 0, bytes: 0 };

  for (const entry of entries) {
    if (isCancelled && isCancelled()) throw makeCancelledError();
    if (isSkippedSourceFile(entry.rel, sourceName)) continue;

    const to = joinRel(destDir, entry.rel);
    if (entry.kind === 'dir') {
      await fs.mkdir(to, { recursive: true });
      continue;
    }
    if (entry.kind === 'link') continue;

    const from = joinRel(sourceDir, entry.rel);
    await callCopyHook(hooks, { phase: 'overlay', rel: entry.rel, from, to });
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    const info = await fs.stat(from).catch(() => null);
    stats.files += 1;
    stats.bytes += info ? info.size : 0;
    if (onFile) onFile({ rel: entry.rel, files: stats.files, bytes: stats.bytes });
  }

  return stats;
}

// ---------------- 备份 ----------------

async function writeManifest(backupDir, manifest) {
  await fs.mkdir(backupDir, { recursive: true });
  // 清单写坏 = 备份不可用，必须原子写。
  await writeJsonAtomic(path.join(backupDir, MANIFEST_NAME), manifest);
}

async function readBackupManifest(backupDir) {
  const file = path.join(path.resolve(String(backupDir || '')), MANIFEST_NAME);
  let parsed = null;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new Error('找不到这次更新的备份记录，无法撤销');
  }
  if (!parsed || parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.overwrite)) {
    throw new Error('这次更新的备份记录已损坏，无法撤销');
  }
  return parsed;
}

/**
 * 把「将被覆盖的原文件」复制到备份目录，并写下清单（新增 / 跳过清单也记进去，
 * 撤销时才能知道哪些文件是本次更新带来的）。
 */
async function backupOverwritten({ targetDir, backupDir, plan, hooks, isCancelled }) {
  const root = path.resolve(backupDir);
  const filesRoot = path.join(root, FILES_DIR);
  await fs.mkdir(filesRoot, { recursive: true });

  let bytes = 0;
  for (const rel of plan.overwrite) {
    if (isCancelled && isCancelled()) throw makeCancelledError();
    const from = joinRel(plan.targetDir, rel);
    const to = joinRel(filesRoot, rel);
    await callCopyHook(hooks, { phase: 'backup', rel, from, to });
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    const info = await fs.stat(from).catch(() => null);
    bytes += info ? info.size : 0;
  }

  const manifest = {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    targetDir: plan.targetDir,
    sourceName: plan.sourceName,
    overwrite: plan.overwrite.slice(),
    create: plan.create.slice(),
    skipped: plan.skipped.slice(),
    files: plan.overwrite.length,
    bytes,
    restoredAt: null
  };
  await writeManifest(root, manifest);

  return { dir: root, manifest, bytes, files: plan.overwrite.length };
}

// ---------------- 合并 ----------------

/**
 * 影子目录 + 原子替换地合并，并在动手前备份将被覆盖的文件。
 *
 * @param {object} options
 * @param {string} options.sourceDir   staging 实例目录
 * @param {string} options.targetDir   目标实例目录（与 sourceDir 同一个 versions/ 父目录）
 * @param {string} [options.backupDir] 备份目录（放在实例目录之外，例如 userData 下）
 * @param {string} [options.sourceName] staging 的文件夹名（用于跳过它的版本 json）
 * @param {AbortSignal} [options.signal]
 * @param {Function} [options.isCancelled] 额外的合作式取消判定
 * @param {Function} [options.onProgress] ({ message, percent, phase, rel })
 * @param {{onBeforeCopy?: Function}} [options.hooks] 测试钩子（生产不使用）
 * @returns {Promise<object>} 覆盖 / 新增 / 跳过清单、字节数、backupDir
 */
async function mergeWithBackup(options = {}) {
  if (!options.sourceDir || !options.targetDir) throw new Error('合并需要源目录和目标目录');

  const sourceDir = path.resolve(String(options.sourceDir));
  const targetDir = path.resolve(String(options.targetDir));
  if (sourceDir === targetDir) throw new Error('不能把整合包合并到它自己');

  const parent = path.dirname(targetDir);
  const baseName = path.basename(targetDir);
  // 临时目录必须和实例在同一个父目录（同一分区），rename 才是原子的。
  const token = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const tmpDir = path.join(parent, `.${baseName}.${MERGE_MARKER}-${token}.tmp`);
  const oldDir = path.join(parent, `.${baseName}.${MERGE_MARKER}-${token}.old`);

  const isCancelled = cancellationChecker(options);
  const hooks = options.hooks || null;
  const report = typeof options.onProgress === 'function' ? options.onProgress : null;
  const progress = (message, percent, extra) => {
    if (isCancelled()) throw makeCancelledError();
    if (report) report({ message, percent, ...(extra || {}) });
  };

  const sourceName = String(options.sourceName || path.basename(sourceDir));
  const plan = await planMerge({ sourceDir, targetDir, sourceName });

  const backupDir = options.backupDir ? path.resolve(String(options.backupDir)) : '';
  if (backupDir) {
    // 备份绝不能放进实例目录：会被当成实例内容扫描 / 备份进下一份备份。
    const relToTarget = path.relative(targetDir, backupDir);
    if (!relToTarget || (!relToTarget.startsWith('..') && !path.isAbsolute(relToTarget))) {
      throw new Error('备份目录不能放在实例目录里');
    }
  }
  let backup = null;
  let tmpExists = false;
  let targetMoved = false;
  let stats = { files: 0, bytes: 0 };

  try {
    if (backupDir) {
      progress('正在备份将被覆盖的文件…', 8, { phase: 'backup' });
      backup = await backupOverwritten({
        targetDir,
        backupDir,
        plan,
        hooks,
        isCancelled
      });
    }

    progress('正在准备影子目录…', 20, { phase: 'shadow' });
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpExists = true;
    await copyTreeTo(targetDir, tmpDir, {
      phase: 'shadow',
      hooks,
      isCancelled,
      onFile: ({ files }) => {
        // 每 50 个文件报一次，别把 IPC 刷爆。
        if (files % 50 === 0 && report) {
          report({
            message: `正在复制实例文件（${files} 个）…`,
            percent: Math.min(48, 20 + Math.floor(files / 50)),
            phase: 'shadow'
          });
        }
      }
    });

    progress('正在把新整合包写入影子目录…', 55, { phase: 'overlay' });
    stats = await overlayInto({
      sourceDir,
      destDir: tmpDir,
      sourceName,
      hooks,
      isCancelled,
      onFile: ({ files }) => {
        if (files % 50 === 0 && report) {
          report({
            message: `正在写入新文件（${files} 个）…`,
            percent: Math.min(88, 55 + Math.floor(files / 50)),
            phase: 'overlay'
          });
        }
      }
    });

    progress('正在替换实例目录…', 90, { phase: 'swap' });
    await fs.rename(targetDir, oldDir);
    targetMoved = true;

    // 最危险的窗口：旧目录已经挪走、新目录还没就位。取消必须在这里折返。
    if (isCancelled()) throw makeCancelledError();

    await fs.rename(tmpDir, targetDir);
    tmpExists = false;
  } catch (error) {
    // 失败路径：先清影子目录，再把旧实例改回去；目标目录必须保持可启动。
    if (tmpExists) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    let rollback = 'none';
    let rollbackError = null;
    if (targetMoved) {
      try {
        await renameWithRetry(oldDir, targetDir);
        rollback = 'renamed';
        targetMoved = false;
      } catch (renameError) {
        rollbackError = renameError;
        // rename 改不回去（例如被占用）时退回整树复制，宁可慢也不能让实例消失。
        try {
          await fs.cp(oldDir, targetDir, { recursive: true, force: true, errorOnExist: false });
          rollback = 'copied';
          targetMoved = false;
        } catch (copyError) {
          rollback = 'failed';
          rollbackError = copyError;
        }
      }
    }

    const cancelled = isAbortError(error);
    const reason = cancelled
      ? '已取消'
      : `更新整合包失败：${error && error.message ? error.message : error}`;
    const suffix = rollback === 'failed'
      ? `；自动回滚失败，原实例完整保留在 ${oldDir}，请手动把它改名回 ${targetDir}`
      : '；已回滚，实例保持更新前的状态';

    const wrapped = new Error(`${reason}${suffix}`);
    wrapped.cancelled = cancelled;
    wrapped.code = cancelled ? 'TASK_CANCELLED' : 'MERGE_FAILED';
    wrapped.cause = error;
    wrapped.rolledBack = rollback !== 'failed';
    wrapped.staleDir = rollback === 'failed' ? oldDir : '';
    wrapped.backupDir = backup ? backup.dir : '';
    throw wrapped;
  }

  // 成功：删掉回退目录。删不掉也只是多一个隐藏目录，不影响实例被识别。
  let staleDir = '';
  try {
    await fs.rm(oldDir, { recursive: true, force: true });
  } catch (error) {
    staleDir = oldDir;
    console.warn('[instance-merge] could not remove old instance dir:', oldDir, error && error.message);
  }

  // 成功之后再按保留策略清理该实例更早的备份：只增不减会让备份目录无限增长。
  // 清理失败只 warn，绝不影响「合并已经成功」这个事实。
  let prunedBackups = 0;
  if (backup) {
    try {
      const pruned = await pruneMergedBackups({ backupRoot: path.dirname(backup.dir) });
      prunedBackups = pruned.removed.length;
    } catch (error) {
      console.warn('[instance-merge] could not prune old backups:', error && error.message);
    }
  }

  return {
    ok: true,
    sourceDir,
    targetDir,
    overwrite: plan.overwrite,
    create: plan.create,
    skipped: plan.skipped,
    counts: {
      overwrite: plan.overwrite.length,
      create: plan.create.length,
      skipped: plan.skipped.length
    },
    files: plan.overwrite.length + plan.create.length,
    bytes: stats.bytes,
    backupDir: backup ? backup.dir : '',
    backupFiles: backup ? backup.files : 0,
    manifest: backup ? backup.manifest : null,
    prunedBackups,
    staleDir
  };
}

/**
 * 用备份把实例还原到「更新前」：还原被覆盖的文件，删掉本次新增的文件。
 * 每个备份只能撤销一次（清单里记 restoredAt），避免重复撤销覆盖用户后来的修改。
 */
async function restoreFromBackup({ targetDir, backupDir } = {}) {
  const target = path.resolve(String(targetDir || ''));
  const backup = path.resolve(String(backupDir || ''));
  if (!targetDir || !backupDir) throw new Error('撤销需要实例目录和备份目录');

  const manifest = await readBackupManifest(backup);
  const recordedTarget = path.resolve(String(manifest.targetDir || ''));
  if (recordedTarget.toLowerCase() !== target.toLowerCase()) {
    throw new Error('这份备份不属于当前实例，已拒绝撤销');
  }
  if (manifest.restoredAt) {
    throw new Error('这次更新已经撤销过了，不能重复撤销');
  }

  const filesRoot = path.join(backup, FILES_DIR);
  let restored = 0;
  let removed = 0;
  const missing = [];

  for (const rel of manifest.overwrite) {
    const from = joinRel(filesRoot, rel);
    const to = joinRel(target, rel);
    if (!(await pathExists(from))) {
      missing.push(rel);
      continue;
    }
    await copyFileAtomicInto(from, to);
    restored += 1;
  }

  for (const rel of Array.isArray(manifest.create) ? manifest.create : []) {
    const to = joinRel(target, rel);
    if (await pathExists(to)) {
      await fs.rm(to, { recursive: true, force: true });
      removed += 1;
    }
  }

  manifest.restoredAt = new Date().toISOString();
  await writeManifest(backup, manifest);

  return { restored, removed, missing, manifest, targetDir: target, backupDir: backup };
}

// ---------------- 启动期自愈 ----------------

/** 清扫动作的默认日志出口：只用 console，主进程的 app-log 会一并落盘。 */
function defaultMergeLog(message) {
  console.warn(`[instance-merge] ${message}`);
}

function stampForName(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * 启动期清扫「进程在两次 rename 之间被强杀」留下的残留目录。
 *
 * 只做只读判定 + 最小改名/删除，四种现场：
 *   - `.old` 在、目标不在：rename `.old` → 目标名，实例回来；若同时还有 `.tmp`
 *     （那是已经覆盖完成、只是没就位的**新**实例），把它改名成
 *     `.<目标名>.mcdl-merge-lost-<时间戳>` 留在 versions 下（`.` 前缀继续躲开实例扫描），
 *     绝不删除；
 *   - `.old` 在、目标也在：swap 已完成、只是清理失败 → 只删 `.old`，不动目标；
 *   - 只有 `.tmp`、目标在：合并没走到 swap → 删掉半成品副本；
 *   - 只有 `.tmp`、目标不在：无法判断完整性 → 不改名、不删除，只记日志。
 *
 * 为什么「只有 .tmp + 目标缺失」保留而不改名成目标：.tmp 可能是「复制了一半」
 * 的影子目录，把它顶成实例等于把一个残缺的实例塞给用户；宁可什么都不做，
 * 让用户在日志里找到它，也不要让启动器扫描到一个半成品实例。
 *
 * 安全边界：
 *   - 只处理父目录（versionsRoot）basename 正好是 `versions` 的情况；
 *   - 只处理名字里带 `.mcdl-merge-` 且以 `.` 开头的真实目录（符号链接不碰）；
 *   - 任何异常只 warn，绝不抛出，绝不阻塞启动。
 *
 * @param {object} options
 * @param {string} options.versionsRoot  `<gameDir>/versions`
 * @param {Function} [options.log]       日志函数（默认 console.warn）
 * @returns {Promise<{handled: Array<object>}>} 实际做过的动作
 */
async function recoverInterruptedMerges({ versionsRoot, log } = {}) {
  const handled = [];
  const writeLog = typeof log === 'function' ? log : defaultMergeLog;

  try {
    if (!versionsRoot) return { handled };
    const root = path.resolve(String(versionsRoot));
    if (path.basename(root).toLowerCase() !== 'versions') {
      writeLog(`跳过非 versions 目录的合并残留清扫：${root}`);
      return { handled };
    }

    let dirents = [];
    try {
      dirents = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return { handled };
    }

    /** 按「实例名」归组：同一实例的多份残留要放在一起判断，不能逐个瞎猜。 */
    const groups = new Map();
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name;
      // 双保险：实例扫描就是跳过 `.` 开头的目录，我们只处理这一类。
      if (!name.startsWith('.')) continue;
      const match = MERGE_LEFTOVER_PATTERN.exec(name);
      if (!match) continue;

      const entry = {
        name,
        kind: match[3],
        abs: path.join(root, name),
        mtime: 0
      };
      try {
        entry.mtime = (await fs.lstat(entry.abs)).mtimeMs;
      } catch {
        continue;
      }

      const key = match[1].toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { base: match[1], target: path.join(root, match[1]), olds: [], tmps: [] });
      }
      const group = groups.get(key);
      if (entry.kind === 'old') group.olds.push(entry);
      else group.tmps.push(entry);
    }

    for (const group of groups.values()) {
      // 多份 .old 时用最新的那份恢复（其余的是更早的副本，后面按「目标已存在」清理）。
      group.olds.sort((a, b) => b.mtime - a.mtime);

      let targetExists = await pathExists(group.target);
      let restoredNow = false;

      // 1) .old 在、目标不在：swap 卡在两次 rename 之间，把旧实例改名回来。
      if (!targetExists && group.olds.length > 0) {
        const newest = group.olds[0];
        try {
          await fs.rename(newest.abs, group.target);
          targetExists = true;
          restoredNow = true;
          group.olds.shift();
          handled.push({ action: 'restore', kind: 'old', from: newest.abs, to: group.target });
          writeLog(`已恢复被中断的更新：${newest.abs} → ${group.target}`);
        } catch (error) {
          writeLog(`恢复被中断的更新失败，保持原样：${newest.abs}（${error && error.message}）`);
        }
      }

      // 2) 剩下的 .old：目标已经在 = swap 完成只是清理失败 → 删掉上一版副本。
      for (const entry of group.olds) {
        if (!targetExists) {
          handled.push({ action: 'skip', kind: 'old', path: entry.abs, reason: 'target-missing' });
          writeLog(`实例目录仍缺失，保留旧副本待人工处理：${entry.abs}`);
          continue;
        }
        try {
          await fs.rm(entry.abs, { recursive: true, force: true });
          handled.push({ action: 'remove', kind: 'old', path: entry.abs });
          writeLog(`已清理上次合并遗留的旧副本：${entry.abs}`);
        } catch (error) {
          writeLog(`清理旧副本失败，保持原样：${entry.abs}（${error && error.message}）`);
        }
      }

      // 3) .tmp：刚恢复过 = 它是覆盖完成但没就位的新实例，改名留档；否则按上表处理。
      for (const entry of group.tmps) {
        if (restoredNow) {
          const lostName = `.${group.base}.${MERGE_MARKER}-lost-${stampForName()}`;
          const lostPath = path.join(root, lostName);
          try {
            await fs.rename(entry.abs, lostPath);
            handled.push({ action: 'preserve', kind: 'tmp', from: entry.abs, to: lostPath });
            writeLog(
              `本次更新已备份到 ${lostPath}（实例已恢复到更新前；确认无误后可手动删除该目录）`
            );
          } catch (error) {
            // 改名失败就原样留着：绝不因为收尾失败而丢数据。
            handled.push({ action: 'skip', kind: 'tmp', path: entry.abs, reason: 'rename-failed' });
            writeLog(`影子目录改名失败，保持原样：${entry.abs}（${error && error.message}）`);
          }
          continue;
        }

        if (!targetExists) {
          handled.push({ action: 'skip', kind: 'tmp', path: entry.abs, reason: 'target-missing' });
          writeLog(`实例目录缺失、只剩未完成的影子目录，保留待排查：${entry.abs}`);
          continue;
        }

        try {
          await fs.rm(entry.abs, { recursive: true, force: true });
          handled.push({ action: 'remove', kind: 'tmp', path: entry.abs });
          writeLog(`已清理未完成合并的影子目录：${entry.abs}`);
        } catch (error) {
          writeLog(`清理影子目录失败，保持原样：${entry.abs}（${error && error.message}）`);
        }
      }
    }
  } catch (error) {
    writeLog(`扫描合并残留时出错（不影响启动）：${error && error.message}`);
  }

  return { handled };
}

// ---------------- 备份保留 ----------------

/**
 * 只留最近 keep 份合并备份，删掉更早的。
 *
 * 删除前的三重保护（缺一不删）：
 *   1) 必须是 backupRoot 下的**目录**（不是文件、不是符号链接）；
 *   2) 目录名必须匹配我们写的时间戳格式（`2025-08-14T12-34-56-789Z`）；
 *   3) 目录里必须有能被 readBackupManifest 解析的合法 manifest.json。
 * 任何一条不满足都跳过——用户在备份根目录里自己放的东西一律不碰。
 *
 * 排序用目录名（定长 ISO 时间戳）而不是 mtime：名字不会被复制 / 解压改掉。
 *
 * @param {object} options
 * @param {string} options.backupRoot 某个实例自己的备份父目录
 * @param {number} [options.keep]     保留份数（默认 KEEP_BACKUPS；0 表示全删）
 * @param {Function} [options.log]
 * @returns {Promise<{removed:string[],kept:string[],skipped:Array<object>}>}
 */
async function pruneMergedBackups({ backupRoot, keep = KEEP_BACKUPS, log } = {}) {
  const removed = [];
  const kept = [];
  const skipped = [];
  const writeLog = typeof log === 'function' ? log : defaultMergeLog;

  try {
    if (!backupRoot) return { removed, kept, skipped };
    const root = path.resolve(String(backupRoot));

    // null / NaN / 负数一律退回默认值：未来做成设置项时，一个空值绝不能变成「全删」。
    let limit = keep === undefined || keep === null ? KEEP_BACKUPS : Math.floor(Number(keep));
    if (!Number.isFinite(limit) || limit < 0) limit = KEEP_BACKUPS;

    let dirents = [];
    try {
      dirents = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return { removed, kept, skipped };
    }

    const candidates = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (!BACKUP_STAMP_PATTERN.test(dirent.name)) {
        skipped.push({ path: path.join(root, dirent.name), reason: 'name-mismatch' });
        continue;
      }
      const abs = path.join(root, dirent.name);
      try {
        await readBackupManifest(abs);
      } catch {
        // 没有清单 / 清单损坏 = 不是我们写的完整备份，绝不删。
        skipped.push({ path: abs, reason: 'no-manifest' });
        continue;
      }
      candidates.push({ name: dirent.name, abs });
    }

    // 名字是定长 ISO 时间戳，字典序倒序 = 从新到旧。
    candidates.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const entry of candidates.slice(0, limit)) kept.push(entry.abs);

    for (const entry of candidates.slice(limit)) {
      try {
        await fs.rm(entry.abs, { recursive: true, force: true });
        removed.push(entry.abs);
        writeLog(`已清理较旧的合并备份：${entry.abs}`);
      } catch (error) {
        skipped.push({ path: entry.abs, reason: 'remove-failed' });
        writeLog(`清理旧备份失败，已跳过：${entry.abs}（${error && error.message}）`);
      }
    }
  } catch (error) {
    writeLog(`清理合并备份时出错（不影响合并结果）：${error && error.message}`);
  }

  return { removed, kept, skipped };
}

// ---------------- 工具 ----------------

/**
 * 文件级原子还原：先复制到同目录的 `.tmp`，再 rename 顶掉目标。
 * 撤销过程中途被杀，目标文件要么是旧内容、要么是备份内容，不会出现半截文件。
 */
async function copyFileAtomicInto(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  const token = `${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const tmp = path.join(path.dirname(to), `.${path.basename(to)}.${token}.tmp`);
  try {
    await fs.copyFile(from, tmp);
    await renameWithRetry(tmp, to);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

/** rename 重试：杀毒软件 / 索引器短暂占用目标目录时会 EPERM。 */
async function renameWithRetry(from, to, attempts = 5) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RENAME.has(error && error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * (i + 1)));
    }
  }
  throw lastError;
}

module.exports = {
  MANIFEST_VERSION,
  MANIFEST_NAME,
  FILES_DIR,
  MERGE_MARKER,
  KEEP_BACKUPS,
  planMerge,
  mergeWithBackup,
  restoreFromBackup,
  readBackupManifest,
  recoverInterruptedMerges,
  pruneMergedBackups,
  // 导出给测试 / 诊断用
  _internal: {
    assertSafeRel,
    joinRel,
    walkTree,
    isSkippedSourceFile,
    copyTreeTo,
    backupOverwritten,
    renameWithRetry,
    BACKUP_STAMP_PATTERN,
    MERGE_LEFTOVER_PATTERN
  }
};
