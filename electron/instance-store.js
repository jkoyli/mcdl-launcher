'use strict';

/**
 * 实例级数据：单独的内存 / Java / JVM 参数、自定义图标、内容管理（模组 / 资源包 / 世界 / 原理图）。
 *
 * 配置文件（都在启动器数据目录）：
 *   instance-settings.json  { "<versionDir>": { memoryMb, javaPath, jvmArgs, width, height } }
 *   instance-icons.json     { "<versionDir>": { type:'builtin', key } | { type:'file', file } }
 *
 * 内容管理只碰游戏目录下固定的几个子目录，做删除 / 启停前都会校验路径。
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { assertInsideReal } = require('./path-guard');

const CONTENT_DIRS = {
  mods: 'mods',
  resourcepacks: 'resourcepacks',
  saves: 'saves',
  schematics: 'schematics',
  shaderpacks: 'shaderpacks',
  screenshots: 'screenshots',
  logs: 'logs',
  'crash-reports': 'crash-reports',
  config: 'config'
};

const MAX_ENTRIES = 2000;
const MAX_ICON_BYTES = 4 * 1024 * 1024;

function keyOf(versionDir) {
  return path.resolve(versionDir);
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    throw new Error(`无法写入 ${path.basename(file)}（${error.code || 'ERROR'}）：${file}`);
  }
}

function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const result = {};

  const memory = Number(value.memoryMb);
  if (Number.isFinite(memory) && memory > 0) result.memoryMb = Math.round(memory);

  const width = Number(value.width);
  if (Number.isFinite(width) && width > 0) result.width = Math.round(width);

  const height = Number(value.height);
  if (Number.isFinite(height) && height > 0) result.height = Math.round(height);

  if (typeof value.javaPath === 'string' && value.javaPath.trim()) result.javaPath = value.javaPath.trim();
  if (typeof value.jvmArgs === 'string' && value.jvmArgs.trim()) result.jvmArgs = value.jvmArgs.trim();

  return result;
}

function createInstanceStore({ storeDir, launcherHome }) {
  const settingsFile = path.join(storeDir, 'instance-settings.json');
  const iconsFile = path.join(storeDir, 'instance-icons.json');
  const iconsDir = path.join(storeDir, 'icons');
  const home = launcherHome ? path.resolve(launcherHome) : null;

  let settingsCache = null;
  let iconsCache = null;
  // 「默认版本隔离策略」：auto（按目录判断，历史行为）/ isolated / global
  let isolationMode = 'auto';

  async function loadSettings() {
    if (!settingsCache) settingsCache = await readJson(settingsFile, {});
    return settingsCache;
  }

  async function loadIcons() {
    if (!iconsCache) iconsCache = await readJson(iconsFile, {});
    return iconsCache;
  }

  function contentSubdir(kind) {
    const sub = CONTENT_DIRS[kind];
    if (!sub) throw new Error(`不支持的内容类型：${kind}`);
    return sub;
  }

  /**
   * 内容目录解析：优先「版本隔离」目录（HMCL / PCL 的默认做法）。
   *
   *   versions/<id>/mods   版本隔离（HMCL、PCL 装整合包时用）
   *   .minecraft/mods      全局目录（原版默认）
   *
   * 规则：设置里的「默认版本隔离策略」优先（isolated / global）；auto 时
   * 版本目录里已经有这个子目录就用它，否则游戏目录里有就用游戏目录；
   * 都没有时，外部实例（别的启动器）按隔离目录新建，自己的实例按全局目录新建。
   */
  async function contentRootFor(instance, kind) {
    const sub = contentSubdir(kind);
    const versionDir = instance && instance.path ? path.resolve(instance.path) : '';
    const gameDir = instance && instance.gameDir ? path.resolve(instance.gameDir) : '';

    const versionRoot = versionDir ? path.join(versionDir, sub) : '';
    const gameRoot = gameDir ? path.join(gameDir, sub) : '';

    const isDir = async (target) => {
      if (!target) return false;
      try {
        return (await fs.stat(target)).isDirectory();
      } catch {
        return false;
      }
    };

    if (isolationMode === 'isolated' && versionRoot) return versionRoot;
    if (isolationMode === 'global' && gameRoot) return gameRoot;

    if (await isDir(versionRoot)) return versionRoot;
    if (await isDir(gameRoot)) return gameRoot;
    if (!versionRoot) return gameRoot;
    if (!gameRoot) return versionRoot;

    return instance.origin === 'external' ? versionRoot : gameRoot;
  }

  return {
    // ---------------- 全局偏好 ----------------

    /** 默认版本隔离策略：auto / isolated / global。 */
    setIsolationMode(mode) {
      isolationMode = ['auto', 'isolated', 'global'].includes(mode) ? mode : 'auto';
      return isolationMode;
    },

    getIsolationMode() {
      return isolationMode;
    },

    // ---------------- 实例级设置 ----------------

    async getSettings(versionDir) {
      const all = await loadSettings();
      return normalizeSettings(all[keyOf(versionDir)]);
    },

    /**
     * 只覆盖 patch 里出现的字段；空字符串 / 空值表示「改回继承全局」。
     */
    async saveSettings(versionDir, patch) {
      const all = await loadSettings();
      const key = keyOf(versionDir);
      const next = normalizeSettings(all[key]);

      const apply = (name, parse) => {
        if (!patch || !(name in patch)) return;
        const value = parse(patch[name]);
        if (value === undefined) delete next[name];
        else next[name] = value;
      };

      apply('memoryMb', (value) => {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
      });

      apply('width', (value) => {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
      });

      apply('height', (value) => {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
      });

      apply('javaPath', (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined));
      apply('jvmArgs', (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined));

      if (Object.keys(next).length === 0) delete all[key];
      else all[key] = next;

      await writeJson(settingsFile, all);
      return next;
    },

    // ---------------- 实例图标 ----------------

    async getIcon(versionDir) {
      const all = await loadIcons();
      const entry = all[keyOf(versionDir)];
      if (!entry || typeof entry !== 'object') return null;
      if (entry.type === 'builtin' && entry.key) return { type: 'builtin', key: String(entry.key) };
      if (entry.type === 'file' && entry.file) return { type: 'file', file: String(entry.file) };
      return null;
    },

    /** 返回可直接给 <img> 用的 data URL。 */
    async iconData(versionDir) {
      const icon = await this.getIcon(versionDir);
      if (!icon || icon.type !== 'file') return { icon, dataUrl: null };
      try {
        const file = path.join(iconsDir, icon.file);
        const buffer = await fs.readFile(file);
        return { icon, dataUrl: `data:${mimeOf(icon.file)};base64,${buffer.toString('base64')}` };
      } catch {
        return { icon, dataUrl: null };
      }
    },

    async setBuiltinIcon(versionDir, key) {
      const all = await loadIcons();
      all[keyOf(versionDir)] = { type: 'builtin', key: String(key || 'grass') };
      await writeJson(iconsFile, all);
      return { type: 'builtin', key: String(key || 'grass') };
    },

    async setFileIcon(versionDir, sourcePath) {
      const buffer = await fs.readFile(sourcePath);
      if (buffer.length === 0) throw new Error('图标文件是空的');
      if (buffer.length > MAX_ICON_BYTES) throw new Error('图标不能超过 4 MB');

      const ext = (path.extname(sourcePath) || '.png').toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
        throw new Error('图标需要是 PNG / JPG / WebP / GIF');
      }

      await fs.mkdir(iconsDir, { recursive: true });
      const file = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16) + ext;
      await fs.writeFile(path.join(iconsDir, file), buffer);

      const all = await loadIcons();
      all[keyOf(versionDir)] = { type: 'file', file };
      await writeJson(iconsFile, all);

      return {
        icon: { type: 'file', file },
        dataUrl: `data:${mimeOf(file)};base64,${buffer.toString('base64')}`
      };
    },

    async clearIcon(versionDir) {
      const all = await loadIcons();
      delete all[keyOf(versionDir)];
      await writeJson(iconsFile, all);
      return null;
    },

    // ---------------- 内容管理 ----------------

    async folderFor(instance, kind) {
      const root = await contentRootFor(instance, kind);
      await fs.mkdir(root, { recursive: true }).catch(() => {});
      return root;
    },

    /**
     * 列出某个内容目录。
     * @returns {Promise<{root:string, entries:Array}>}
     */
    async listContent(instance, kind) {
      const root = await contentRootFor(instance, kind);
      let dirents = [];
      try {
        dirents = await fs.readdir(root, { withFileTypes: true });
      } catch {
        return { root, exists: false, entries: [] };
      }

      const entries = [];

      for (const dirent of dirents) {
        if (entries.length >= MAX_ENTRIES) break;
        if (dirent.name.startsWith('.')) continue;

        const full = path.join(root, dirent.name);
        let stat = null;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }

        const isDisabled = kind === 'mods' && dirent.name.toLowerCase().endsWith('.disabled');
        if (kind !== 'mods' && (dirent.name.endsWith('.disabled'))) continue;

        entries.push({
          name: dirent.name.replace(/\.disabled$/i, ''),
          rawName: dirent.name,
          path: full,
          isDirectory: stat.isDirectory(),
          size: stat.isDirectory() ? 0 : stat.size,
          modifiedAt: stat.mtime.toISOString(),
          enabled: kind === 'mods' ? !isDisabled : true
        });
      }

      entries.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
      return { root, exists: true, entries };
    },

    /**
     * 模组启用 / 禁用：改扩展名，不动文件内容。
     *
     * 和 deleteContent 一样必须先确认目标在 mods 目录内——这里只改一个后缀，
     * 但"改任意文件的后缀"在生产环境里同样是破坏性的（比如让 EDR 的配置失效）。
     */
    async setModEnabled(instance, filePath, enabled) {
      const root = await contentRootFor(instance, 'mods');
      const target = await assertInsideReal(root, String(filePath || ''), '要启停的文件');
      const name = path.basename(target);
      const isDisabled = name.toLowerCase().endsWith('.disabled');

      if (enabled && !isDisabled) return { path: target, enabled: true };
      if (!enabled && isDisabled) return { path: target, enabled: false };

      const nextName = enabled ? name.replace(/\.disabled$/i, '') : `${name}.disabled`;
      const nextPath = path.join(path.dirname(target), nextName);
      await fs.rename(target, nextPath);
      return { path: nextPath, enabled: Boolean(enabled) };
    },

    /** 删除前必须确认目标在对应内容目录内。 */
    async deleteContent({ instance, kind, target }) {
      const root = await contentRootFor(instance, kind);
      const resolved = await assertInsideReal(root, String(target || ''), '要删除的文件');
      await fs.rm(resolved, { recursive: true, force: true });
      return true;
    },

    /** 导入：把选中的文件复制到对应内容目录（重名自动加序号）。 */
    async importContent({ instance, kind, sourcePaths }) {
      const root = await contentRootFor(instance, kind);
      await fs.mkdir(root, { recursive: true });

      const imported = [];

      for (const sourcePath of sourcePaths || []) {
        const name = path.basename(sourcePath);
        let target = path.join(root, name);

        for (let index = 1; index < 100; index += 1) {
          try {
            await fs.access(target);
            const ext = path.extname(name);
            target = path.join(root, `${path.basename(name, ext)} (${index})${ext}`);
          } catch {
            break;
          }
        }

        await fs.copyFile(sourcePath, target);
        imported.push(target);
      }

      return imported;
    }
  };
}

function mimeOf(file) {
  const ext = path.extname(String(file)).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

module.exports = { createInstanceStore, CONTENT_DIRS };
