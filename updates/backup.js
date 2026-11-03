#!/usr/bin/env node
'use strict';

/**
 * 把一个「更新」快照进 updates/<name>/。
 *
 * 内容：
 *   files/        本次改动涉及的所有文件（相对路径原样保留）
 *   manifest.json 基线 tag / commit、文件 SHA-256 与大小、测试与产物记录
 *   CHANGELOG.md  人写的更新说明（不存在时生成模板，不覆盖已有内容）
 *
 * 用法：
 *   node updates/backup.js <name> [--base <git-ref>] [--note "一句话"]
 *
 * 例：
 *   node updates/backup.js 2026-11-03-music-java
 *   node updates/backup.js 0.3.3 --base v0.3.2 --note "音乐播放器 + Java 镜像"
 *
 * 说明：
 *   - 默认基线取当前 HEAD 能追到的最近 tag（通常是上一个已发布版本）；
 *   - 改动清单 = `git diff <base>`（含工作区未提交改动）+ 未跟踪文件；
 *   - 只复制仍然存在的文件，删除过的文件在 manifest.deleted 里记录路径；
 *   - 不复制 dist/、node_modules/ 等产物/依赖；要发版的 zip 请把文件名与
 *     SHA-256 填进 manifest.artifact（zip 本身太大，不放进备份目录）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const updatesDir = __dirname;

function git(args) {
  // core.quotepath=false：中文路径按原样输出，否则 git 会转义成
  // "\350\246..."，既复制不到文件、也会被误判成删除。
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: repo,
    encoding: 'utf8'
  }).trim();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function latestTag() {
  try {
    return git(['describe', '--tags', '--abbrev=0']);
  } catch {
    return '';
  }
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function parseArgs(argv) {
  const options = { name: '', base: '', note: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') {
      options.base = argv[++i] || '';
    } else if (arg === '--note') {
      options.note = argv[++i] || '';
    } else if (!arg.startsWith('--') && !options.name) {
      options.name = arg;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options.name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(options.name)) {
  console.error('用法：node updates/backup.js <name> [--base <git-ref>] [--note "一句话"]');
  console.error('name 只能用字母 / 数字 / . _ -（例如 2026-11-03-music-java 或 0.3.3）');
  process.exit(2);
}

const base = options.base || latestTag();
if (!base) {
  console.error('找不到基线 tag，请用 --base 指定上一个发布点（例如 --base v0.3.1）。');
  process.exit(2);
}

const baseCommit = git(['rev-parse', `${base}^{commit}`]);
const headCommit = git(['rev-parse', 'HEAD']);
const packageVersion = readJson(path.join(repo, 'electron', 'package.json'), {}).version || '';

// 相对基线的改动（含工作区）+ 未跟踪文件；排除依赖 / 产物 / 已有快照目录。
const ignored = /^(electron\/node_modules|electron\/dist|dist|mcdl\/build|mcdl\/dist|updates\/)/;
const changed = unique(
  git(['diff', '--name-only', base])
    .split(/\r?\n/)
    .concat(git(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/))
).filter((file) => file && !ignored.test(file));

const exists = changed.filter((file) => fs.existsSync(path.join(repo, file)));
const deleted = changed.filter((file) => !fs.existsSync(path.join(repo, file)));

const target = path.join(updatesDir, options.name);
fs.mkdirSync(path.join(target, 'files'), { recursive: true });

const files = [];
for (const rel of exists) {
  const source = path.join(repo, rel);
  const destination = path.join(target, 'files', rel);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const stat = fs.statSync(source);
  files.push({ path: rel, size: stat.size, sha256: sha256(source) });
}

const commits = git(['log', '--oneline', `${base}..HEAD`]).split(/\r?\n/).filter(Boolean);

const manifest = {
  name: options.name,
  createdAt: new Date().toISOString(),
  note: options.note,
  packageVersion,
  base: { ref: base, commit: baseCommit },
  headCommit,
  workingTreeDirty: git(['status', '--porcelain']).length > 0,
  commits,
  files,
  deleted,
  tests: {
    command: 'node --test --test-isolation=none tests/*.test.js',
    total: null,
    passed: null,
    note: '跑完后把 total / passed 填进来'
  },
  artifact: {
    name: '',
    size: 0,
    sha256: '',
    note: '打好的 zip 不进备份目录，只记录文件名 / 大小 / SHA-256'
  }
};

fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

// 覆盖式更新规则跟着快照走：每个快照目录里都能直接看到当前遵守的规则。
const rulesFile = path.join(updatesDir, '覆盖式更新规则.md');
if (fs.existsSync(rulesFile)) {
  fs.copyFileSync(rulesFile, path.join(target, '覆盖式更新规则.md'));
}

const changelog = path.join(target, 'CHANGELOG.md');
if (!fs.existsSync(changelog)) {
  fs.writeFileSync(
    changelog,
    [
      `# ${options.name}`,
      '',
      `- 日期：${new Date().toISOString().slice(0, 10)}`,
      `- 基线：${base}（${baseCommit.slice(0, 7)}）`,
      `- package.json 版本：${packageVersion}`,
      options.note ? `- 备注：${options.note}` : '',
      '',
      '## 新功能',
      '',
      '- ',
      '',
      '## 动效 / UI',
      '',
      '- ',
      '',
      '## 修复',
      '',
      '- ',
      '',
      '## 设置 / 数据',
      '',
      '- ',
      '',
      '## 验证',
      '',
      `- 单测：${manifest.tests.command}`,
      '- 打包：',
      ''
    ].join('\n'),
    'utf8'
  );
}

console.log(`[updates] 快照：${target}`);
console.log(`[updates] 基线 ${base}（${baseCommit.slice(0, 7)}）→ HEAD ${headCommit.slice(0, 7)}`);
console.log(`[updates] 文件 ${files.length} 个，删除 ${deleted.length} 个，commit ${commits.length} 个`);
