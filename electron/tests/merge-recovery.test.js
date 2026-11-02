'use strict';

/**
 * 合并残留自愈 / 备份保留策略的回归测试。
 *
 * 守的是两条「收尾」线：
 *   - 进程在两次 rename 之间被 kill -9 之后，下次启动不能出现「实例凭空消失」，
 *     也不能把未完成的影子目录当成实例塞给用户；
 *   - 合并备份只增不减会无限吃盘，但清理绝不能误删用户自己放进备份目录的东西。
 *
 * 全部跑真文件系统（临时目录），不 mock fs。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const merge = require('../instance-merge');

async function tempRoot(t, prefix = 'mcdl-merge-recovery-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

async function readText(root, rel) {
  return fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 和 mergeWithBackup 的模板一致：`.<实例名>` + `.mcdl-merge-<token>` + `.tmp|.old` */
function leftoverName(base, kind, token = 'tst0001-abcd1234') {
  return `.${base}.${merge.MERGE_MARKER}-${token}.${kind}`;
}

async function makeVersions(t) {
  const root = await tempRoot(t);
  const versions = path.join(root, 'versions');
  await fs.mkdir(versions, { recursive: true });
  return { root, versions };
}

/** 收集恢复后 versions 下的「留档」目录（.mcdl-merge-lost-*）。 */
async function lostDirs(versions) {
  return (await fs.readdir(versions)).filter((name) => name.includes('.mcdl-merge-lost-'));
}

// ---------------- 启动期自愈 ----------------

test('recoverInterruptedMerges：.old 在、目标缺失时把实例改名回来（.tmp 留档不删）', async (t) => {
  const { versions } = await makeVersions(t);
  const oldDir = path.join(versions, leftoverName('my-pack', 'old'));
  const tmpDir = path.join(versions, leftoverName('my-pack', 'tmp'));
  await writeFiles(oldDir, { 'mods/a.jar': 'old-a', 'my-pack.json': '{"id":"my-pack"}' });
  await writeFiles(tmpDir, { 'mods/a.jar': 'new-a', 'mods/b.jar': 'new-b' });
  const target = path.join(versions, 'my-pack');
  assert.equal(await exists(target), false);

  const result = await merge.recoverInterruptedMerges({ versionsRoot: versions, log: () => {} });

  assert.equal(await exists(target), true, '实例目录必须被恢复');
  assert.equal(await readText(target, 'mods/a.jar'), 'old-a', '恢复的是更新前的旧实例');
  assert.equal(await exists(path.join(target, 'mods/b.jar')), false, '新包内容不能混进恢复后的实例');
  assert.equal(await exists(oldDir), false, '.old 已经被改名，不应残留');

  // .tmp 里是「覆盖完成但没就位」的新实例：留档但不改名成目标
  assert.equal(await exists(tmpDir), false, '.tmp 不应继续占用残留名');
  const lost = await lostDirs(versions);
  assert.equal(lost.length, 1, '应生成一个 .mcdl-merge-lost-* 留档目录');
  assert.equal(lost[0].startsWith('.'), true, '留档目录必须是隐藏目录（不被实例扫描识别）');
  assert.equal(await readText(path.join(versions, lost[0]), 'mods/a.jar'), 'new-a');

  const actions = result.handled.map((item) => item.action);
  assert.deepEqual(actions, ['restore', 'preserve']);
});

test('recoverInterruptedMerges：.old 在、目标也在时只删 .old，目标内容不变', async (t) => {
  const { versions } = await makeVersions(t);
  const target = path.join(versions, 'my-pack');
  const oldDir = path.join(versions, leftoverName('my-pack', 'old'));
  await writeFiles(target, { 'mods/a.jar': 'current-a', 'config/keep.toml': 'keep' });
  await writeFiles(oldDir, { 'mods/a.jar': 'old-a' });

  const result = await merge.recoverInterruptedMerges({ versionsRoot: versions, log: () => {} });

  assert.equal(await exists(target), true);
  assert.equal(await readText(target, 'mods/a.jar'), 'current-a', '目标实例绝不能被旧副本覆盖');
  assert.equal(await readText(target, 'config/keep.toml'), 'keep');
  assert.equal(await exists(oldDir), false, 'swap 已完成，旧副本应被清理');
  assert.deepEqual(result.handled.map((item) => item.action), ['remove']);
  assert.equal(result.handled[0].kind, 'old');
});

test('recoverInterruptedMerges：只有 .tmp、目标存在时删掉半成品副本', async (t) => {
  const { versions } = await makeVersions(t);
  const target = path.join(versions, 'my-pack');
  const tmpDir = path.join(versions, leftoverName('my-pack', 'tmp'));
  await writeFiles(target, { 'mods/a.jar': 'current-a' });
  await writeFiles(tmpDir, { 'mods/a.jar': 'half-written' });

  const result = await merge.recoverInterruptedMerges({ versionsRoot: versions, log: () => {} });

  assert.equal(await exists(tmpDir), false, '没走到 swap 的影子目录应清理');
  assert.equal(await readText(target, 'mods/a.jar'), 'current-a');
  assert.deepEqual(result.handled.map((item) => item.action), ['remove']);
  assert.equal(result.handled[0].kind, 'tmp');
});

test('recoverInterruptedMerges：只有 .tmp、目标缺失时不改名不删除', async (t) => {
  const { versions } = await makeVersions(t);
  const tmpDir = path.join(versions, leftoverName('my-pack', 'tmp'));
  await writeFiles(tmpDir, { 'mods/a.jar': 'maybe-incomplete' });
  const target = path.join(versions, 'my-pack');

  const result = await merge.recoverInterruptedMerges({ versionsRoot: versions, log: () => {} });

  assert.equal(await exists(tmpDir), true, '无法判断完整性时绝不能删');
  assert.equal(await exists(target), false, '也不允许把半成品改名成实例');
  assert.deepEqual(result.handled.map((item) => item.action), ['skip']);
  assert.equal(result.handled[0].reason, 'target-missing');
});

test('recoverInterruptedMerges：不碰非 .mcdl-merge 目录、不碰父目录不是 versions 的', async (t) => {
  const { root, versions } = await makeVersions(t);
  const target = path.join(versions, 'my-pack');
  await writeFiles(target, { 'mods/a.jar': 'current' });

  // 1) 名字里没有 .mcdl-merge- 的隐藏目录
  const plainHidden = path.join(versions, '.not-a-merge.old');
  await fs.mkdir(plainHidden, { recursive: true });
  // 2) 有标记但后缀不是 tmp / old
  const otherKind = path.join(versions, '.my-pack.mcdl-merge-t1.bak');
  await fs.mkdir(otherKind, { recursive: true });
  // 3) 没有 `.` 前缀（看起来像实例，绝不能碰）
  const noDot = path.join(versions, 'my-pack.mcdl-merge-t1.old');
  await fs.mkdir(noDot, { recursive: true });
  // 4) 父目录不是 versions
  const notVersions = path.join(root, 'staging');
  const outside = path.join(notVersions, leftoverName('my-pack', 'old'));
  await fs.mkdir(notVersions, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  // 5) versions 之下更深一层的残留（只处理直接子项）
  const nested = path.join(versions, 'nested', leftoverName('my-pack', 'old'));
  await fs.mkdir(nested, { recursive: true });

  const result = await merge.recoverInterruptedMerges({ versionsRoot: versions, log: () => {} });
  assert.deepEqual(result.handled, []);
  for (const dir of [plainHidden, otherKind, noDot, outside, nested]) {
    assert.equal(await exists(dir), true, `${dir} 不应被清理`);
  }

  // 父目录不是 versions：整次调用直接放弃（防误伤用户自定义目录）
  const wrongRoot = path.join(root, 'somewhere-else');
  await fs.mkdir(wrongRoot, { recursive: true });
  const insideWrong = path.join(wrongRoot, leftoverName('my-pack', 'old'));
  await fs.mkdir(insideWrong, { recursive: true });
  const wrongResult = await merge.recoverInterruptedMerges({ versionsRoot: wrongRoot, log: () => {} });
  assert.deepEqual(wrongResult.handled, []);
  assert.equal(await exists(insideWrong), true);
});

test('recoverInterruptedMerges：命名模板与 mergeWithBackup 实际生成的一致', () => {
  assert.equal(merge._internal.MERGE_LEFTOVER_PATTERN.test(leftoverName('my-pack', 'old')), true);
  assert.equal(merge._internal.MERGE_LEFTOVER_PATTERN.test(leftoverName('my-pack', 'tmp')), true);
  // 1.20.1 这种带点的实例名也要能解析出正确的 base
  const match = merge._internal.MERGE_LEFTOVER_PATTERN.exec(leftoverName('1.20.1-fabric', 'old'));
  assert.equal(match[1], '1.20.1-fabric');
  assert.equal(match[3], 'old');
  // 我们的留档目录不能反过来被当成残留
  assert.equal(
    merge._internal.MERGE_LEFTOVER_PATTERN.test('.my-pack.mcdl-merge-lost-2025-01-01T00-00-00-000Z'),
    false
  );
});

test('recoverInterruptedMerges：目录不存在 / 无参数时不抛错', async () => {
  assert.deepEqual((await merge.recoverInterruptedMerges()).handled, []);
  assert.deepEqual((await merge.recoverInterruptedMerges({ versionsRoot: '' })).handled, []);
  const missing = path.join(os.tmpdir(), 'mcdl-does-not-exist', 'versions');
  assert.deepEqual((await merge.recoverInterruptedMerges({ versionsRoot: missing })).handled, []);
});

// ---------------- 备份保留 ----------------

async function writeBackup(backupRoot, stamp, extra = {}) {
  const dir = path.join(backupRoot, stamp);
  await fs.mkdir(path.join(dir, merge.FILES_DIR), { recursive: true });
  await fs.writeFile(path.join(dir, merge.FILES_DIR, 'a.txt'), `backup-${stamp}`);
  const manifest = {
    version: merge.MANIFEST_VERSION,
    createdAt: `${stamp}`,
    targetDir: extra.targetDir || path.join(os.tmpdir(), 'fake-instance'),
    overwrite: ['a.txt'],
    create: [],
    skipped: [],
    restoredAt: null
  };
  await fs.writeFile(path.join(dir, merge.MANIFEST_NAME), JSON.stringify(manifest));
  return dir;
}

const STAMPS = [
  '2025-01-01T00-00-00-000Z',
  '2025-02-01T00-00-00-000Z',
  '2025-03-01T00-00-00-000Z',
  '2025-04-01T00-00-00-000Z',
  '2025-05-01T00-00-00-000Z'
];

test('pruneMergedBackups：默认留最近 3 份，删掉更早的', async (t) => {
  const root = await tempRoot(t);
  const backupRoot = path.join(root, 'instance-merge-backups', 'my-pack-abc123');
  for (const stamp of STAMPS) await writeBackup(backupRoot, stamp);

  const result = await merge.pruneMergedBackups({ backupRoot });

  assert.equal(result.removed.length, 2);
  assert.deepEqual(result.removed.map((dir) => path.basename(dir)).sort(), STAMPS.slice(0, 2).sort());
  const left = (await fs.readdir(backupRoot)).sort();
  assert.deepEqual(left, STAMPS.slice(2).sort());
  // 留下的备份必须还是完整可撤销的
  const manifest = await merge.readBackupManifest(path.join(backupRoot, STAMPS[4]));
  assert.deepEqual(manifest.overwrite, ['a.txt']);
});

test('pruneMergedBackups：没有合法 manifest.json / 名字不匹配的目录一律不删', async (t) => {
  const root = await tempRoot(t);
  const backupRoot = path.join(root, 'backups', 'my-pack');
  const valid = [];
  for (const stamp of STAMPS) valid.push(await writeBackup(backupRoot, stamp));

  // a) 名字像时间戳，但没有 manifest
  const noManifest = path.join(backupRoot, '2024-01-01T00-00-00-000Z');
  await fs.mkdir(path.join(noManifest, merge.FILES_DIR), { recursive: true });
  await fs.writeFile(path.join(noManifest, merge.FILES_DIR, 'user-notes.txt'), 'mine');

  // b) manifest 损坏
  const broken = path.join(backupRoot, '2024-02-01T00-00-00-000Z');
  await fs.mkdir(broken, { recursive: true });
  await fs.writeFile(path.join(broken, merge.MANIFEST_NAME), '{not json');

  // c) 用户自己放进去的文件夹（名字不是我们的时间戳格式），即使有清单也不删
  const userDir = path.join(backupRoot, 'my-own-stuff');
  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(path.join(userDir, merge.MANIFEST_NAME), JSON.stringify({
    version: merge.MANIFEST_VERSION,
    overwrite: []
  }));

  // d) 备份根里的普通文件
  await fs.writeFile(path.join(backupRoot, 'readme.txt'), 'mine');

  const result = await merge.pruneMergedBackups({ backupRoot, keep: 1 });

  assert.deepEqual(result.removed.slice().sort(), valid.slice(0, 4).sort());
  for (const dir of [noManifest, broken, userDir]) {
    assert.equal(await exists(dir), true, `${dir} 不应被删除`);
  }
  assert.equal(await readText(noManifest, 'files/user-notes.txt'), 'mine');
  assert.equal(await exists(path.join(backupRoot, 'readme.txt')), true);
  assert.equal(await exists(valid[4]), true, '最新一份必须保留');

  const skippedReasons = result.skipped.map((item) => item.reason).sort();
  assert.deepEqual(skippedReasons, ['name-mismatch', 'no-manifest', 'no-manifest']);
});

test('pruneMergedBackups：keep 边界（0 份 / 份数不足 / 非法值）', async (t) => {
  const root = await tempRoot(t);
  const backupRoot = path.join(root, 'backups', 'my-pack');
  await writeBackup(backupRoot, STAMPS[0]);
  await writeBackup(backupRoot, STAMPS[1]);

  // 份数不足：一份都不删
  const few = await merge.pruneMergedBackups({ backupRoot, keep: 10 });
  assert.deepEqual(few.removed, []);
  assert.equal(few.kept.length, 2);

  // 负数 / NaN 退回默认值，不会变成「全删」
  const fallback = await merge.pruneMergedBackups({ backupRoot, keep: -1 });
  assert.deepEqual(fallback.removed, []);
  assert.equal(await exists(path.join(backupRoot, STAMPS[0])), true);

  // null（未来设置项没填）同样退回默认值，绝不能清空
  const nullKeep = await merge.pruneMergedBackups({ backupRoot, keep: null });
  assert.deepEqual(nullKeep.removed, []);
  assert.equal(await exists(path.join(backupRoot, STAMPS[1])), true);

  // keep = 0 表示一份都不留（只删合法备份）
  const zero = await merge.pruneMergedBackups({ backupRoot, keep: 0 });
  assert.equal(zero.removed.length, 2);
  assert.deepEqual(await fs.readdir(backupRoot), []);

  // 目录不存在 / 没参数也不抛
  assert.deepEqual((await merge.pruneMergedBackups({ backupRoot: path.join(root, 'nope') })).removed, []);
  assert.deepEqual((await merge.pruneMergedBackups()).removed, []);
});

test('mergeWithBackup：成功合并后自动按保留策略清理更早的备份', async (t) => {
  const root = await tempRoot(t);
  const versions = path.join(root, 'versions');
  const targetDir = path.join(versions, 'my-pack');
  const sourceDir = path.join(versions, 'update-abc');
  const backupRoot = path.join(root, 'instance-merge-backups', 'my-pack-abc123');
  const backupDir = path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-'));

  await writeFiles(targetDir, { 'my-pack.json': '{"id":"my-pack"}', 'mods/a.jar': 'old-a' });
  await writeFiles(sourceDir, { 'mods/a.jar': 'new-a' });

  // 先塞 4 份「更早」的合法备份，合并成功后应只剩最近 3 份（含本次）
  for (const stamp of ['2020-01-01T00-00-00-000Z', '2020-02-01T00-00-00-000Z',
    '2020-03-01T00-00-00-000Z', '2020-04-01T00-00-00-000Z']) {
    await writeBackup(backupRoot, stamp);
  }

  const result = await merge.mergeWithBackup({
    sourceDir,
    targetDir,
    sourceName: 'update-abc',
    backupDir
  });

  assert.equal(result.ok, true);
  assert.equal(result.prunedBackups, 2);
  const left = (await fs.readdir(backupRoot)).sort();
  assert.equal(left.length, merge.KEEP_BACKUPS);
  assert.equal(left.includes(path.basename(backupDir)), true, '本次备份必须保留');
  assert.equal(await readText(targetDir, 'mods/a.jar'), 'new-a');
});
