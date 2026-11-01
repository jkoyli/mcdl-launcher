'use strict';

/**
 * 游戏目录管理（对应清单的 GameDirectoryPage）。
 *
 * 一个 JSON 文件记录启动器管理的游戏目录列表：
 *   [{ id, path, useRelativePath, primary, addedAt }]
 *
 * `path` 始终存绝对路径；`useRelativePath` 只影响展示——路径在启动器目录内时
 * 显示成相对路径（清单里的「若可能，游戏文件夹使用相对路径」）。
 */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function dirId(absPath) {
  return crypto.createHash('sha1').update(String(absPath).toLowerCase()).digest('hex').slice(0, 12);
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function createGameDirectoryStore({ storeDir, defaultDir, launcherHome }) {
  const file = path.join(storeDir, 'game-directories.json');
  const root = launcherHome ? path.resolve(launcherHome) : null;
  let state = null;

  function seed() {
    const primary = path.resolve(defaultDir);
    return {
      dirs: [{
        id: dirId(primary),
        path: primary,
        useRelativePath: false,
        primary: true,
        addedAt: new Date().toISOString()
      }]
    };
  }

  async function load() {
    if (state) return state;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      const dirs = Array.isArray(parsed.dirs) ? parsed.dirs : [];
      state = { dirs: dirs.filter((entry) => entry && typeof entry.path === 'string') };
    } catch {
      state = null;
    }

    if (!state || state.dirs.length === 0) {
      // 第一次运行：用默认目录兜底，并保证它可写（detectGameDir 已经建过标准结构）。
      state = seed();
      await persist();
      return state;
    }

    // 保证恰好有一个 primary
    if (!state.dirs.some((entry) => entry.primary)) {
      state.dirs[0].primary = true;
    }

    return state;
  }

  async function persist() {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      throw new Error(
        `无法写入游戏目录配置（${error.code || 'ERROR'}）：${file}\n` +
        '请确认该目录可写，并关闭其他正在运行的启动器实例后重试'
      );
    }
  }

  /** 展示用路径：在启动器目录内且开启相对路径时返回相对路径。 */
  function displayPath(entry) {
    if (!entry.useRelativePath || !root) return entry.path;
    const relative = path.relative(root, entry.path);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return entry.path;
    return relative;
  }

  function view(entry) {
    return {
      id: entry.id,
      path: entry.path,
      displayPath: displayPath(entry),
      useRelativePath: Boolean(entry.useRelativePath),
      relativePossible: Boolean(root && !path.relative(root, entry.path).startsWith('..')),
      primary: Boolean(entry.primary),
      addedAt: entry.addedAt || null
    };
  }

  async function ensureStructure(dir) {
    const target = path.resolve(dir);

    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) throw new Error('这个路径不是文件夹');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        await fs.mkdir(target, { recursive: true });
      } else if (error && error.message === '这个路径不是文件夹') {
        throw error;
      } else {
        throw new Error(`无法访问这个文件夹：${error.code || error.message}`);
      }
    }

    // 子目录只是「顺手补齐」：已经存在的 .minecraft 常常缺 mods/saves，
    // 权限受限时也不该因此拒绝添加这个文件夹。
    for (const sub of ['versions', 'libraries', 'assets', 'logs', 'mods', 'saves', 'resourcepacks', 'shaderpacks']) {
      await fs.mkdir(path.join(target, sub), { recursive: true }).catch(() => {});
    }

    const marker = path.join(target, 'mcdl-launcher.json');
    try {
      await fs.access(marker);
    } catch {
      await fs.writeFile(marker, JSON.stringify({
        launcher: 'MCDL Launcher',
        layout: 'minecraft',
        createdAt: new Date().toISOString()
      }, null, 2), 'utf8').catch(() => {});
    }

    return target;
  }

  return {
    async list() {
      const current = await load();
      return {
        dirs: current.dirs.map(view),
        launcherHome: root
      };
    },

    /** 只给扫描用：所有被管理目录的绝对路径。 */
    async paths() {
      const current = await load();
      return current.dirs.map((entry) => entry.path);
    },

    async primaryPath() {
      const current = await load();
      const primary = current.dirs.find((entry) => entry.primary) || current.dirs[0];
      return primary ? primary.path : path.resolve(defaultDir);
    },

    /** 新建或更新一个游戏目录；id 为空表示新增。 */
    async save({ id, dirPath, useRelativePath }) {
      const raw = String(dirPath || '').trim();
      if (!raw) throw new Error('请填写游戏文件夹路径');
      if (!path.isAbsolute(raw)) throw new Error('请填写完整路径（例如 D:\\Minecraft\\.minecraft）');

      const resolved = path.resolve(raw);
      let stat = null;
      try {
        stat = await fs.stat(resolved);
      } catch {
        stat = null;
      }
      if (stat && !stat.isDirectory()) throw new Error('这个路径不是文件夹');

      const current = await load();

      const duplicate = current.dirs.find((entry) => entry.id !== id && samePath(entry.path, resolved));
      if (duplicate) throw new Error('这个文件夹已经在列表里了');

      const target = await ensureStructure(resolved);

      if (id) {
        const entry = current.dirs.find((item) => item.id === id);
        if (!entry) throw new Error('游戏目录不存在');
        entry.path = target;
        entry.id = dirId(target);
        entry.useRelativePath = Boolean(useRelativePath);
        await persist();
        return { dir: view(entry), ...(await this.list()) };
      }

      const entry = {
        id: dirId(target),
        path: target,
        useRelativePath: Boolean(useRelativePath),
        primary: false,
        addedAt: new Date().toISOString()
      };
      current.dirs.push(entry);
      await persist();
      return { dir: view(entry), ...(await this.list()) };
    },

    async remove(id) {
      const current = await load();
      const entry = current.dirs.find((item) => item.id === id);
      if (!entry) throw new Error('游戏目录不存在');

      const rest = current.dirs.filter((item) => item.id !== id);
      if (rest.length === 0) throw new Error('至少要保留一个游戏文件夹');

      if (entry.primary) {
        // 把 primary 让给剩下的第一个，保证安装与默认扫描有落点。
        rest[0].primary = true;
      }

      current.dirs = rest;
      await persist();
      return this.list();
    }
  };
}

module.exports = { createGameDirectoryStore };
