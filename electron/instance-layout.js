'use strict';

/**
 * 实例布局：这个实例「游戏真正使用的游戏目录」到底在哪。
 *
 * 背景（这是启动器最严重的一类 bug 的根因）：
 *   - HMCL / PCL 默认开启「版本隔离」，启动游戏时把 --gameDir 指向
 *     <游戏目录>/versions/<实例名>，mods / config / saves 全在实例目录里；
 *   - 而启动器自己的库、资源、版本 JSON 仍在 <游戏目录>（.minecraft）下。
 *
 * 所以「扫描到的别的启动器的实例」必须用两套目录：
 *   基础目录 baseDir = .minecraft（versions / libraries / assets）
 *   游戏目录 gameDir = .minecraft/versions/<id>（mods / config / saves / 日志）
 *
 * 判定规则与 instance-store 的内容目录解析共用（见 auto 模式）：
 *   - 明确设置 isolated → 实例目录；
 *   - 明确设置 global   → 基础目录；
 *   - auto：实例目录里已经出现游戏自己写的内容（mods / config / saves …）
 *     就说明别的启动器是隔离启动的，用实例目录；否则沿用基础目录。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * 只在「隔离启动」时才会出现在 versions/<id>/ 下的内容。
 * 必须是游戏 / 启动器运行时自己写的东西，不能把我们自己安装时建的目录算进来
 * （例如 versions/<id>/natives 是我们解压 natives 用的，原版实例也有，不能当信号）。
 */
const ISOLATION_MARKERS = [
  'mods',
  'config',
  'defaultconfigs',
  'saves',
  'screenshots',
  'resourcepacks',
  'shaderpacks',
  'scripts',
  'kubejs',
  'PCL',
  '.hmcl',
  'options.txt',
  'servers.dat',
  'usercache.json'
];

async function statOrNull(target) {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

/** 实例目录里是否已有游戏内容（有任意一个标记即可）。 */
async function hasIsolatedContent(versionDir) {
  if (!versionDir) return false;

  for (const marker of ISOLATION_MARKERS) {
    const stat = await statOrNull(path.join(versionDir, marker));
    if (!stat) continue;
    // 目录和文件都算：mods 目录、options.txt 文件都是隔离启动的产物。
    return true;
  }

  return false;
}

/**
 * 解析实例的启动布局。
 *
 * @param {object} options
 * @param {string} options.versionDir    实例目录（<gameDir>/versions/<id>）
 * @param {string} options.gameDir       基础游戏目录（.minecraft）
 * @param {'auto'|'isolated'|'global'} [options.isolationMode]
 * @returns {Promise<{gameDir:string, baseDir:string, isolated:boolean}>}
 */
async function resolveGameDir({ versionDir, gameDir, isolationMode = 'auto' } = {}) {
  const version = versionDir ? path.resolve(versionDir) : '';
  const base = gameDir ? path.resolve(gameDir) : '';

  if (!version && !base) throw new Error('实例路径不完整');
  if (!base) return { gameDir: version, baseDir: version, isolated: true };
  if (!version) return { gameDir: base, baseDir: base, isolated: false };

  if (isolationMode === 'isolated') return { gameDir: version, baseDir: base, isolated: true };
  if (isolationMode === 'global') return { gameDir: base, baseDir: base, isolated: false };

  const isolated = await hasIsolatedContent(version);
  return isolated
    ? { gameDir: version, baseDir: base, isolated: true }
    : { gameDir: base, baseDir: base, isolated: false };
}

module.exports = {
  ISOLATION_MARKERS,
  hasIsolatedContent,
  resolveGameDir
};
