'use strict';

/**
 * 世界（存档）管理：列表、level.dat 读写、导出、备份、数据包。
 *
 * 目录约定：
 *   <gameDir>/saves/<世界>/level.dat
 *   <userData>/world-backups/<saves 路径哈希>/<世界>__<时间戳>.zip
 *
 * 备份与导出用系统自带的 bsdtar（Windows 10+ 的 tar.exe），不引入 zip 依赖。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const nbt = require('./nbt');

const MAX_BACKUP_ICON = 400 * 1024;

const GAME_TYPES = ['生存', '创造', '冒险', '旁观'];
const DIFFICULTIES = ['和平', '简单', '普通', '困难'];

function worldError(message) {
  const error = new Error(message);
  error.name = 'WorldError';
  return error;
}

/** 世界目录名只允许普通文件夹名，防止 ../ 穿越。 */
function assertFolderName(folder) {
  const name = String(folder || '').trim();
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
    throw worldError('非法的世界目录名');
  }
  return name;
}

function inside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

function worldDir(savesRoot, folder) {
  const root = path.resolve(savesRoot);
  const target = path.join(root, assertFolderName(folder));
  if (!inside(root, target)) throw worldError('世界目录不在存档目录内');
  return target;
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(worldError(`tar 执行失败：${String(stderr || error.message).trim().split(/\r?\n/).slice(-3).join(' ')}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(full)).size;
      } catch {
        // 忽略被占用的文件
      }
    }
  }
  return total;
}

async function readIcon(worldPath) {
  const file = path.join(worldPath, 'icon.png');
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BACKUP_ICON) return '';
    const buffer = await fs.readFile(file);
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

/**
 * 读 level.dat 里界面要用的字段。
 * @returns {Promise<object>}
 */
async function readWorldInfo(worldPath, folder) {
  const levelFile = path.join(worldPath, 'level.dat');
  const info = {
    folder,
    path: worldPath,
    name: folder,
    levelName: folder,
    gameType: 0,
    difficulty: 2,
    difficultyLocked: false,
    allowCommands: false,
    generateFeatures: true,
    seed: '',
    versionName: '',
    lastPlayed: '',
    hasLevelDat: false,
    size: await dirSize(worldPath),
    iconDataUrl: await readIcon(worldPath)
  };

  try {
    const root = await nbt.readFile(levelFile);
    info.hasLevelDat = true;
    info.levelName = nbt.getString(root, 'Data', 'LevelName') || folder;
    info.gameType = nbt.getNumber(root, 'Data', 'GameType') ?? 0;
    info.difficulty = nbt.getNumber(root, 'Data', 'Difficulty') ?? 2;
    info.difficultyLocked = nbt.getBoolean(root, 'Data', 'DifficultyLocked');
    info.allowCommands = nbt.getBoolean(root, 'Data', 'allowCommands');
    info.generateFeatures = nbt.getBoolean(root, 'Data', 'generateFeatures');
    info.seed = nbt.getLongString(root, 'Data', 'RandomSeed');
    info.versionName = nbt.getString(root, 'Data', 'Version', 'Name');
    const lastPlayed = nbt.getNumber(root, 'Data', 'LastPlayed');
    info.lastPlayed = lastPlayed ? new Date(lastPlayed).toISOString() : '';
  } catch (error) {
    info.readError = error.message;
  }

  return info;
}

async function listWorlds(savesRoot) {
  const root = path.resolve(savesRoot);
  const result = { root, exists: true, worlds: [] };

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { root, exists: false, worlds: [] };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const worldPath = path.join(root, entry.name);
    result.worlds.push(await readWorldInfo(worldPath, entry.name));
  }

  result.worlds.sort((a, b) => String(b.lastPlayed).localeCompare(String(a.lastPlayed)));
  return result;
}

async function readWorld(savesRoot, folder) {
  const dir = worldDir(savesRoot, folder);
  return readWorldInfo(dir, assertFolderName(folder));
}

/**
 * 写 level.dat：先复制一份 level.dat_old，再覆盖。
 * @param {{allowCommands?:boolean, generateFeatures?:boolean, difficulty?:number,
 *          difficultyLocked?:boolean, gameType?:number, levelName?:string}} patch
 */
async function saveWorld(savesRoot, folder, patch = {}) {
  const dir = worldDir(savesRoot, folder);
  const levelFile = path.join(dir, 'level.dat');

  let root;
  try {
    root = await nbt.readFile(levelFile);
  } catch (error) {
    throw worldError(`读不了 level.dat：${error.message}`);
  }

  if (patch.allowCommands !== undefined) nbt.setByte(root, patch.allowCommands, 'Data', 'allowCommands');
  if (patch.generateFeatures !== undefined) nbt.setByte(root, patch.generateFeatures, 'Data', 'generateFeatures');
  if (patch.difficultyLocked !== undefined) nbt.setByte(root, patch.difficultyLocked, 'Data', 'DifficultyLocked');

  if (patch.difficulty !== undefined) {
    const value = Number(patch.difficulty);
    if (!Number.isInteger(value) || value < 0 || value > 3) throw worldError('难度只能是 0–3');
    nbt.setByte(root, value, 'Data', 'Difficulty');
  }

  if (patch.gameType !== undefined) {
    const value = Number(patch.gameType);
    if (!Number.isInteger(value) || value < 0 || value > 3) throw worldError('游戏模式只能是 0–3');
    nbt.setInt(root, value, 'Data', 'GameType');
  }

  // 世界显示名称（≠ 文件夹名）：游戏内与启动器列表都读这个字段。
  if (patch.levelName !== undefined) {
    const name = String(patch.levelName || '').trim();
    if (!name) throw worldError('世界名称不能为空');
    if (name.length > 64) throw worldError('世界名称不能超过 64 个字符');
    nbt.setString(root, name, 'Data', 'LevelName');
  }

  await fs.copyFile(levelFile, path.join(dir, 'level.dat_old')).catch(() => {});
  await nbt.writeFile(levelFile, root);
  return readWorldInfo(dir, folder);
}

async function deleteWorld(savesRoot, folder) {
  const dir = worldDir(savesRoot, folder);
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}

async function duplicateWorld(savesRoot, folder) {
  const root = path.resolve(savesRoot);
  const source = worldDir(root, folder);
  const name = assertFolderName(folder);
  let target = path.join(root, `${name} - 副本`);
  for (let index = 2; index < 100; index += 1) {
    try {
      await fs.access(target);
      target = path.join(root, `${name} - 副本 (${index})`);
    } catch {
      break;
    }
  }
  await fs.cp(source, target, { recursive: true });
  return { folder: path.basename(target) };
}

async function exportWorld(savesRoot, folder, targetFile) {
  const root = path.resolve(savesRoot);
  const name = assertFolderName(folder);
  const target = path.resolve(String(targetFile || ''));
  if (!target.toLowerCase().endsWith('.zip')) throw worldError('导出文件必须是 .zip');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await runTar(['-a', '-c', '-f', target, '-C', root, name]);
  const stat = await fs.stat(target);
  return { file: target, size: stat.size };
}

// ---------------- 备份 ----------------

function backupDirOf(backupsRoot, savesRoot) {
  const hash = crypto.createHash('sha1').update(path.resolve(savesRoot)).digest('hex').slice(0, 12);
  return path.join(path.resolve(backupsRoot), hash);
}

async function createBackup(backupsRoot, savesRoot, folder) {
  const root = path.resolve(savesRoot);
  const name = assertFolderName(folder);
  const dir = backupDirOf(backupsRoot, root);
  await fs.mkdir(dir, { recursive: true });

  const file = path.join(dir, `${name}__${stamp()}.zip`);
  await runTar(['-a', '-c', '-f', file, '-C', root, name]);
  const stat = await fs.stat(file);
  return { file, folder: name, size: stat.size, at: new Date().toISOString() };
}

async function listBackups(backupsRoot, savesRoot) {
  const dir = backupDirOf(backupsRoot, savesRoot);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { dir, backups: [] };
  }

  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) continue;
    const full = path.join(dir, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    const base = entry.name.replace(/\.zip$/i, '');
    const split = base.lastIndexOf('__');
    backups.push({
      file: full,
      name: entry.name,
      folder: split > 0 ? base.slice(0, split) : base,
      at: (split > 0 ? base.slice(split + 2) : ''),
      size: stat.size,
      mtime: stat.mtime.toISOString()
    });
  }

  backups.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return { dir, backups };
}

async function restoreBackup(backupsRoot, savesRoot, backupFile) {
  const dir = path.resolve(backupsRoot);
  const file = path.resolve(String(backupFile || ''));
  if (!inside(dir, file)) throw worldError('备份文件不在备份目录内');

  const root = path.resolve(savesRoot);
  const temp = path.join(dir, `.restore-${Date.now()}`);
  await fs.mkdir(temp, { recursive: true });

  try {
    await runTar(['-x', '-f', file, '-C', temp]);
    const extracted = (await fs.readdir(temp, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (extracted.length === 0) throw worldError('备份里没有找到世界目录');

    const source = path.join(temp, extracted[0].name);
    const name = extracted[0].name;
    let target = path.join(root, `${name} (恢复 ${stamp()})`);
    await fs.cp(source, target, { recursive: true });
    return { folder: path.basename(target) };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function deleteBackup(backupsRoot, backupFile) {
  const dir = path.resolve(backupsRoot);
  const file = path.resolve(String(backupFile || ''));
  if (!inside(dir, file)) throw worldError('备份文件不在备份目录内');
  await fs.rm(file, { force: true });
  return true;
}

// ---------------- 数据包 ----------------

async function listDatapacks(savesRoot, folder) {
  const dir = path.join(worldDir(savesRoot, folder), 'datapacks');
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { dir, exists: false, packs: [] };
  }

  const packs = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    packs.push({
      name: entry.name,
      path: full,
      isDirectory: entry.isDirectory(),
      size: entry.isDirectory() ? await dirSize(full) : stat.size,
      modifiedAt: stat.mtime.toISOString()
    });
  }

  packs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return { dir, exists: true, packs };
}

async function importDatapack(savesRoot, folder, sourcePath) {
  const dir = path.join(worldDir(savesRoot, folder), 'datapacks');
  await fs.mkdir(dir, { recursive: true });

  const source = path.resolve(String(sourcePath || ''));
  const filename = path.basename(source);
  if (!filename) throw worldError('非法的数据包路径');

  let target = path.join(dir, filename);
  for (let index = 1; index < 100; index += 1) {
    try {
      await fs.access(target);
      const ext = path.extname(filename);
      target = path.join(dir, `${path.basename(filename, ext)} (${index})${ext}`);
    } catch {
      break;
    }
  }

  const stat = await fs.stat(source);
  if (stat.isDirectory()) await fs.cp(source, target, { recursive: true });
  else await fs.copyFile(source, target);
  return { path: target };
}

async function deleteDatapack(savesRoot, folder, name) {
  const dir = path.join(worldDir(savesRoot, folder), 'datapacks');
  const target = path.join(dir, path.basename(String(name || '')));
  if (!inside(dir, target)) throw worldError('数据包不在该世界目录内');
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

module.exports = {
  GAME_TYPES,
  DIFFICULTIES,
  listWorlds,
  readWorld,
  saveWorld,
  deleteWorld,
  duplicateWorld,
  exportWorld,
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  listDatapacks,
  importDatapack,
  deleteDatapack,
  backupDirOf,
  worldDir
};
