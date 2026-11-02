'use strict';

/**
 * instance-merge 回归测试。
 *
 * 守的是「更新整合包绝不能把用户实例改成半新半旧」这条线：
 *   - 覆盖 / 新增的分类要准（UI 合并报告、备份范围都靠它）；
 *   - 中途失败 / 取消必须回滚，目标实例保持原样且不残留临时目录；
 *   - 备份内容必须和「被覆盖前的原文件」逐字节一致，撤销能还原；
 *   - staging 的版本 json 不能混进目标实例。
 *
 * 全部跑真文件系统（临时目录），不 mock fs。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const merge = require('../instance-merge');

async function tempRoot(t, prefix = 'mcdl-merge-') {
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

/** 模拟真实布局：<gameDir>/versions/<id>，临时实例与目标实例在同一个 versions 下。 */
async function makeLayout(t) {
  const root = await tempRoot(t);
  const versions = path.join(root, 'versions');
  const targetDir = path.join(versions, 'my-pack');
  const sourceDir = path.join(versions, 'update-abc');
  const backupDir = path.join(root, 'instance-merge-backups', 'my-pack', 'stamp');

  await writeFiles(targetDir, {
    'my-pack.json': '{"id":"my-pack"}',
    'mods/keep.jar': 'keep',
    'mods/a.jar': 'old-a',
    'config/old.toml': 'old-config',
    'saves/world/level.dat': 'world'
  });
  await writeFiles(sourceDir, {
    'update-abc.json': '{"id":"update-abc"}',
    'update-abc.jar': 'staging-jar',
    '.mcdl-import.json': '{"state":"partial"}',
    'mods/a.jar': 'new-a',
    'mods/b.jar': 'new-b',
    'config/new.toml': 'new-config'
  });
  // 空的 saves 目录也要在合并后保留
  await fs.mkdir(path.join(targetDir, 'saves'), { recursive: true });

  return { root, versions, targetDir, sourceDir, backupDir };
}

async function mergeDirs(options) {
  return merge.mergeWithBackup({
    sourceName: 'update-abc',
    ...options
  });
}

async function leftoverMergeDirs(versionsDir) {
  const names = await fs.readdir(versionsDir);
  return names.filter((name) => name.includes(merge.MERGE_MARKER));
}

// ---------------- 规划 ----------------

test('planMerge：overwrite / create / skipped 分类正确（相对路径）', async (t) => {
  const { targetDir, sourceDir } = await makeLayout(t);
  const plan = await merge.planMerge({ sourceDir, targetDir, sourceName: 'update-abc' });

  assert.deepEqual(plan.overwrite, ['mods/a.jar']);
  assert.deepEqual(plan.create, ['config/new.toml', 'mods/b.jar']);
  assert.deepEqual(plan.skipped, ['.mcdl-import.json', 'update-abc.jar', 'update-abc.json']);
  for (const rel of [...plan.overwrite, ...plan.create, ...plan.skipped]) {
    assert.equal(rel.includes('\\'), false, `相对路径必须用 / 分隔：${rel}`);
    assert.equal(path.isAbsolute(rel), false);
  }
});

test('planMerge：空源目录不产生任何改动项', async (t) => {
  const root = await tempRoot(t);
  const source = path.join(root, 'empty');
  const target = path.join(root, 'target');
  await fs.mkdir(source, { recursive: true });
  await writeFiles(target, { 'a.txt': 'a' });

  const plan = await merge.planMerge({ sourceDir: source, targetDir: target, sourceName: 'empty' });
  assert.deepEqual(plan.overwrite, []);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.skipped, []);
});

test('planMerge：拒绝把实例合并到它自己', async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(
    () => merge.planMerge({ sourceDir: root, targetDir: root }),
    /合并到它自己/
  );
});

// ---------------- 正常合并 ----------------

test('mergeWithBackup：正常合并，覆盖原文件、新增文件，实例其它内容不动', async (t) => {
  const { versions, targetDir, sourceDir, backupDir } = await makeLayout(t);

  const result = await mergeDirs({ sourceDir, targetDir, backupDir });

  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { overwrite: 1, create: 2, skipped: 3 });
  assert.equal(result.files, 3);

  // 覆盖 / 新增
  assert.equal(await readText(targetDir, 'mods/a.jar'), 'new-a');
  assert.equal(await readText(targetDir, 'mods/b.jar'), 'new-b');
  assert.equal(await readText(targetDir, 'config/new.toml'), 'new-config');
  // 原有内容（新包里没有的）必须保留
  assert.equal(await readText(targetDir, 'mods/keep.jar'), 'keep');
  assert.equal(await readText(targetDir, 'config/old.toml'), 'old-config');
  assert.equal(await readText(targetDir, 'saves/world/level.dat'), 'world');
  assert.equal(await readText(targetDir, 'my-pack.json'), '{"id":"my-pack"}');
  // 空目录也保留
  assert.equal((await fs.stat(path.join(targetDir, 'saves'))).isDirectory(), true);

  // 版本元数据不能进目标实例
  assert.equal(await exists(path.join(targetDir, 'update-abc.json')), false);
  assert.equal(await exists(path.join(targetDir, 'update-abc.jar')), false);
  assert.equal(await exists(path.join(targetDir, '.mcdl-import.json')), false);

  // 不留下任何临时 / 回退目录
  assert.deepEqual(await leftoverMergeDirs(versions), []);
  assert.equal(result.staleDir, '');
});

test('mergeWithBackup：备份目录内容与被覆盖的原文件逐字节一致', async (t) => {
  const { targetDir, sourceDir, backupDir } = await makeLayout(t);

  await mergeDirs({ sourceDir, targetDir, backupDir });

  const backedUp = path.join(backupDir, merge.FILES_DIR, 'mods', 'a.jar');
  assert.equal(await fs.readFile(backedUp, 'utf8'), 'old-a');

  // 只备份「会被覆盖」的文件，不备份新增的、也不备份没被碰到的
  assert.equal(await exists(path.join(backupDir, merge.FILES_DIR, 'mods', 'b.jar')), false);
  assert.equal(await exists(path.join(backupDir, merge.FILES_DIR, 'mods', 'keep.jar')), false);

  const manifest = JSON.parse(await fs.readFile(path.join(backupDir, merge.MANIFEST_NAME), 'utf8'));
  assert.equal(manifest.version, merge.MANIFEST_VERSION);
  assert.deepEqual(manifest.overwrite, ['mods/a.jar']);
  assert.deepEqual(manifest.create, ['config/new.toml', 'mods/b.jar']);
  assert.deepEqual(manifest.skipped, ['.mcdl-import.json', 'update-abc.jar', 'update-abc.json']);
  assert.equal(manifest.targetDir, targetDir);
  assert.equal(manifest.restoredAt, null);
});

test('mergeWithBackup：没有 backupDir 也能合并（只是没有撤销能力）', async (t) => {
  const { targetDir, sourceDir } = await makeLayout(t);
  const result = await mergeDirs({ sourceDir, targetDir });
  assert.equal(result.ok, true);
  assert.equal(result.backupDir, '');
  assert.equal(await readText(targetDir, 'mods/a.jar'), 'new-a');
});

test('mergeWithBackup：拒绝把备份目录放进实例目录（会被当成实例内容）', async (t) => {
  const { targetDir, sourceDir } = await makeLayout(t);
  const inside = path.join(targetDir, 'merge-backup');
  await assert.rejects(
    () => mergeDirs({ sourceDir, targetDir, backupDir: inside }),
    /备份目录不能放在实例目录里/
  );
  assert.equal(await exists(inside), false);
  assert.equal(await readText(targetDir, 'mods/a.jar'), 'old-a');
});

// ---------------- 失败回滚 ----------------

test('mergeWithBackup：第二个文件复制失败时回滚，实例内容与目录结构完全不变', async (t) => {
  const { versions, targetDir, sourceDir, backupDir } = await makeLayout(t);
  const before = {
    'mods/a.jar': await readText(targetDir, 'mods/a.jar'),
    'mods/keep.jar': await readText(targetDir, 'mods/keep.jar'),
    'config/old.toml': await readText(targetDir, 'config/old.toml')
  };

  let overlayCopies = 0;
  const hooks = {
    onBeforeCopy: ({ phase }) => {
      if (phase !== 'overlay') return;
      overlayCopies += 1;
      if (overlayCopies === 2) throw new Error('模拟磁盘写入失败');
    }
  };

  await assert.rejects(
    () => mergeDirs({ sourceDir, targetDir, backupDir, hooks }),
    (error) => {
      assert.match(error.message, /模拟磁盘写入失败/);
      assert.match(error.message, /已回滚/);
      assert.equal(error.rolledBack, true);
      return true;
    }
  );

  for (const [rel, content] of Object.entries(before)) {
    assert.equal(await readText(targetDir, rel), content, `${rel} 必须保持更新前内容`);
  }
  assert.equal(await exists(path.join(targetDir, 'mods/b.jar')), false, '新增文件不能残留');
  assert.equal(await exists(path.join(targetDir, 'config/new.toml')), false);
  assert.deepEqual(await leftoverMergeDirs(versions), [], '不能留下 .mcdl-merge 临时目录');

  // 备份仍然可用（用户至少还能拿到改动前的原文件）
  assert.equal(
    await fs.readFile(path.join(backupDir, merge.FILES_DIR, 'mods', 'a.jar'), 'utf8'),
    'old-a'
  );
});

test('mergeWithBackup：备份阶段就失败时不动实例', async (t) => {
  const { targetDir, sourceDir, backupDir } = await makeLayout(t);
  const hooks = {
    onBeforeCopy: ({ phase }) => {
      if (phase === 'backup') throw new Error('备份盘不可写');
    }
  };

  await assert.rejects(
    () => mergeDirs({ sourceDir, targetDir, backupDir, hooks }),
    /已回滚/
  );
  assert.equal(await readText(targetDir, 'mods/a.jar'), 'old-a');
  assert.equal(await readText(targetDir, 'config/old.toml'), 'old-config');
  assert.equal(await exists(path.join(targetDir, 'config/new.toml')), false);
});

test('mergeWithBackup：取消（abort）也回滚，错误标记成 cancelled', async (t) => {
  const { versions, targetDir, sourceDir, backupDir } = await makeLayout(t);
  const controller = new AbortController();
  let overlayCopies = 0;
  const hooks = {
    onBeforeCopy: ({ phase }) => {
      if (phase !== 'overlay') return;
      overlayCopies += 1;
      if (overlayCopies === 2) controller.abort();
    }
  };

  await assert.rejects(
    () => mergeDirs({ sourceDir, targetDir, backupDir, signal: controller.signal, hooks }),
    (error) => {
      assert.equal(error.cancelled, true);
      assert.equal(error.code, 'TASK_CANCELLED');
      assert.match(error.message, /已取消/);
      assert.match(error.message, /已回滚/);
      return true;
    }
  );

  assert.equal(await readText(targetDir, 'mods/a.jar'), 'old-a');
  assert.equal(await readText(targetDir, 'mods/keep.jar'), 'keep');
  assert.equal(await exists(path.join(targetDir, 'config/new.toml')), false);
  assert.deepEqual(await leftoverMergeDirs(versions), []);
});

test('mergeWithBackup：合作式 isCancelled 返回 true 同样回滚', async (t) => {
  const { targetDir, sourceDir } = await makeLayout(t);
  await assert.rejects(
    () => mergeDirs({ sourceDir, targetDir, isCancelled: () => true }),
    (error) => {
      assert.equal(error.cancelled, true);
      return true;
    }
  );
  assert.equal(await readText(targetDir, 'mods/a.jar'), 'old-a');
});

// ---------------- 撤销 ----------------

test('restoreFromBackup：还原被覆盖的文件、删除本次新增的文件', async (t) => {
  const { targetDir, sourceDir, backupDir } = await makeLayout(t);
  await mergeDirs({ sourceDir, targetDir, backupDir });

  assert.equal(await readText(targetDir, 'mods/a.jar'), 'new-a');

  const restored = await merge.restoreFromBackup({ targetDir, backupDir });
  assert.equal(restored.restored, 1);
  assert.equal(restored.removed, 2);
  assert.deepEqual(restored.missing, []);

  assert.equal(await readText(targetDir, 'mods/a.jar'), 'old-a', '被覆盖的文件必须还原');
  assert.equal(await exists(path.join(targetDir, 'mods/b.jar')), false, '新增文件必须删除');
  assert.equal(await exists(path.join(targetDir, 'config/new.toml')), false);
  assert.equal(await readText(targetDir, 'mods/keep.jar'), 'keep', '没被碰过的文件不受影响');
  assert.equal(await readText(targetDir, 'config/old.toml'), 'old-config');
  // 还原要原子：不能在 mods / config 里留下 .tmp 半截文件
  for (const dir of ['mods', 'config']) {
    const leftovers = (await fs.readdir(path.join(targetDir, dir))).filter((name) => name.startsWith('.'));
    assert.deepEqual(leftovers, [], `${dir} 里不能残留临时文件`);
  }

  // 第二次撤销必须拒绝，避免把用户后来的修改再覆盖回旧版本
  await assert.rejects(
    () => merge.restoreFromBackup({ targetDir, backupDir }),
    /已经撤销过/
  );
});

test('restoreFromBackup：备份与实例不匹配时拒绝', async (t) => {
  const { root, targetDir, sourceDir, backupDir } = await makeLayout(t);
  await mergeDirs({ sourceDir, targetDir, backupDir });

  const otherTarget = path.join(root, 'versions', 'other-pack');
  await writeFiles(otherTarget, { 'mods/a.jar': 'other' });

  await assert.rejects(
    () => merge.restoreFromBackup({ targetDir: otherTarget, backupDir }),
    /不属于当前实例/
  );
  assert.equal(await readText(otherTarget, 'mods/a.jar'), 'other');
});

test('restoreFromBackup：拒绝清单里的越界路径（防篡改）', async (t) => {
  const { root, targetDir, backupDir } = await makeLayout(t);
  const evil = path.join(root, 'evil.txt');
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(
    path.join(backupDir, merge.MANIFEST_NAME),
    JSON.stringify({
      version: merge.MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      targetDir,
      overwrite: ['../evil.txt'],
      create: [],
      skipped: [],
      restoredAt: null
    })
  );

  await assert.rejects(
    () => merge.restoreFromBackup({ targetDir, backupDir }),
    /路径越界|路径非法/
  );
  assert.equal(await exists(evil), false);
});

test('restoreFromBackup：没有清单时报错而不是乱还原', async (t) => {
  const { targetDir, backupDir } = await makeLayout(t);
  await fs.mkdir(backupDir, { recursive: true });
  await assert.rejects(
    () => merge.restoreFromBackup({ targetDir, backupDir }),
    /找不到这次更新的备份记录/
  );
});
