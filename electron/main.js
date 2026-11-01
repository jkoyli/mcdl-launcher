'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const mcdl = require('./mcdl-service');
const javaRuntime = require('./java-runtime');
const launcher = require('./launch');
const accounts = require('./accounts');

const IS_DEV = process.argv.includes('--dev');

console.log(`[main] booting Electron app (dev=${IS_DEV})`);

/**
 * 数据目录选择。
 *
 * 默认是 %APPDATA%\mcdl-launcher-electron。少数机器上（安全软件策略、受限会话、
 * 漫游配置异常）这个目录对 Electron 进程不可写，会导致账号 / 设置 / Chromium 缓存
 * 全部写入失败（表现为 accounts.json 的 EPERM）。这里先做一次写探针，不可写就依次
 * 回退到 %LOCALAPPDATA%、程序目录下的 data/、临时目录。
 *
 * 必须在 app ready 之前调用，否则 Chromium 已经按默认路径初始化过 session。
 */
function chooseUserDataDir() {
  const candidates = [
    process.env.MCDL_USER_DATA,
    path.join(app.getPath('appData'), 'mcdl-launcher-electron'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'mcdl-launcher-electron'),
    path.join(__dirname, 'data'),
    path.join(require('node:os').tmpdir(), 'mcdl-launcher-electron')
  ];

  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fsSync.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      fsSync.writeFileSync(probe, '1', 'utf8');
      fsSync.unlinkSync(probe);
      return dir;
    } catch (error) {
      console.warn(`[data] not writable, trying next: ${dir} (${error.code || error.message})`);
    }
  }

  return null;
}

const USER_DATA_DIR = chooseUserDataDir();
if (USER_DATA_DIR) {
  app.setPath('userData', USER_DATA_DIR);
  console.log(`[data] userData: ${USER_DATA_DIR}`);
} else {
  console.error('[data] no writable data directory; accounts and settings cannot be saved');
}

/**
 * 渲染策略。
 *
 *   显式软件渲染：MCDL_RENDER=software / MCDL_DISABLE_GPU=1 / --software-render
 *   显式硬件加速：MCDL_RENDER=gpu
 *   未指定：默认硬件加速；若上次运行 GPU 子进程崩溃，7 天内自动退回软件渲染
 *
 * 默认走硬件加速，是因为软件合成下大面积 backdrop-filter 与渐变动画会把帧率压到 20 出头，
 * 首屏还要补一次全窗口光栅化，表现为启动后几秒明显卡顿。
 */
const GPU_CRASH_MARKER_TTL = 7 * 24 * 60 * 60 * 1000;

function gpuCrashMarkerFile() {
  return path.join(app.getPath('userData'), 'gpu-crash.json');
}

function readGpuCrashMarker() {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(gpuCrashMarkerFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function recordGpuCrash(details) {
  try {
    fsSync.mkdirSync(path.dirname(gpuCrashMarkerFile()), { recursive: true });
    fsSync.writeFileSync(gpuCrashMarkerFile(), JSON.stringify({
      at: Date.now(),
      reason: details && details.reason,
      exitCode: details && details.exitCode,
      appVersion: app.getVersion()
    }, null, 2), 'utf8');
  } catch (error) {
    console.warn('[gpu] cannot write crash marker:', error.message);
  }
}

function resolveRenderMode() {
  const forced = String(process.env.MCDL_RENDER || '').trim().toLowerCase();

  if (forced === 'software') return 'software';
  if (forced === 'gpu') return 'gpu';
  if (process.env.MCDL_DISABLE_GPU === '1') return 'software';
  if (process.argv.includes('--software-render')) return 'software';

  const marker = readGpuCrashMarker();
  if (marker && Date.now() - Number(marker.at || 0) < GPU_CRASH_MARKER_TTL) {
    console.warn('[gpu] previous GPU crash found, using software rendering:', new Date(Number(marker.at)).toISOString());
    return 'software';
  }

  return 'gpu';
}

const RENDER_MODE = resolveRenderMode();
console.log(`[main] render mode: ${RENDER_MODE}`);

if (RENDER_MODE === 'software') {
  app.disableHardwareAcceleration();
}

// 高分屏：不要强制 1x 设备像素比。
// 让 Chromium 按 Windows 原生 DPI 渲染，避免先以 1x 绘制、再被系统放大造成模糊。
// 如果某个特殊环境确实需要锁定比例，可临时设置：
// app.commandLine.appendSwitch('force-device-scale-factor', '1.25');

process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('[main] unhandledRejection:', error);
});

/**
 * GPU 子进程崩溃：记录标记后以软件渲染重启一次。
 * 重启命令带 --software-render，因此不会再触发这条路径，不会循环。
 */
app.on('child-process-gone', (_event, details) => {
  if (!details || details.type !== 'GPU') return;

  console.error('[gpu] GPU process gone:', details.reason, details.exitCode);

  if (RENDER_MODE === 'software') return;
  if (process.argv.includes('--software-render')) return;
  if (details.reason !== 'crashed' && details.reason !== 'abnormal-exit' && details.reason !== 'launch-failed') {
    return;
  }

  recordGpuCrash(details);
  console.warn('[gpu] relaunching with software rendering');

  app.relaunch({ args: process.argv.slice(1).concat('--software-render') });
  app.exit(0);
});

let mainWindow = null;
let accountStore = null;

function getAccountStore() {
  if (!accountStore) {
    accountStore = accounts.createAccountStore(app.getPath('userData'));
  }
  return accountStore;
}

const PNG_SIGNATURE = '89504e470d0a1a0a';
const MAX_SKIN_BYTES = 4 * 1024 * 1024;

/**
 * 校验皮肤 PNG：只看文件头，避免把任意文件写进数据目录。
 * 允许 64x64 / 64x32 以及它们的高清倍数。
 */
async function readSkinPng(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new Error('找不到这个文件');
  }
  if (!stat.isFile()) throw new Error('请选择一个文件');
  if (stat.size > MAX_SKIN_BYTES) throw new Error('皮肤文件不能超过 4 MB');
  if (stat.size < 33) throw new Error('文件太小，不是有效的 PNG 皮肤');

  const handle = await fs.open(filePath, 'r');
  let header;
  try {
    header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
  } finally {
    await handle.close();
  }

  if (header.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new Error('皮肤需要是 PNG 格式');
  }

  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  const validSize = [64, 128, 256, 512].includes(width) && (height === width || height === width / 2);
  if (!validSize) {
    throw new Error(`皮肤尺寸应为 64×64 / 64×32（或它们的高清倍数），当前是 ${width}×${height}`);
  }

  return { width, height };
}

async function readSkinData(id) {
  if (!id) return { dataUrl: null, model: 'classic' };
  const file = await getAccountStore().getSkinPath(id);
  if (!file) return { dataUrl: null, model: 'classic' };
  try {
    const buffer = await fs.readFile(file);
    return { dataUrl: `data:image/png;base64,${buffer.toString('base64')}`, model: null };
  } catch {
    return { dataUrl: null, model: 'classic' };
  }
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'launcher-settings.json');
}

const DEFAULT_SETTINGS = {
  memoryMb: launcher.defaultMemoryMb(),
  width: launcher.DEFAULT_WIDTH,
  height: launcher.DEFAULT_HEIGHT,
  jvmArgs: '',
  javaPath: ''
};

async function readSettings() {
  let raw = {};
  try {
    raw = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
  } catch {
    raw = {};
  }

  const normalized = launcher.normalizeSettings({ ...DEFAULT_SETTINGS, ...raw });
  return {
    memoryMb: normalized.memoryMb,
    width: normalized.width,
    height: normalized.height,
    jvmArgs: normalized.jvmArgs,
    javaPath: normalized.javaPath
  };
}

async function writeSettings(patch) {
  const current = await readSettings();
  const merged = launcher.normalizeSettings({ ...current, ...patch });
  const next = {
    memoryMb: merged.memoryMb,
    width: merged.width,
    height: merged.height,
    jvmArgs: merged.jvmArgs,
    javaPath: merged.javaPath
  };

  const file = settingsFile();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8');
  } catch (error) {
    throw new Error(
      `无法写入设置文件（${error.code || 'ERROR'}）：${file}\n` +
      '请确认该目录可写，并关闭其他正在运行的启动器实例后重试'
    );
  }

  return next;
}

/**
 * 启动自检：数据目录不可写时明确记一条日志，避免之后只看到零散的 EPERM。
 */
async function checkUserDataWritable() {
  const dir = app.getPath('userData');
  const probe = path.join(dir, '.write-probe');
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, String(Date.now()), 'utf8');
    await fs.unlink(probe);
    console.log(`[data] userData writable: ${dir}`);
    return true;
  } catch (error) {
    console.error(`[data] userData NOT writable: ${dir} -> ${error.code || ''} ${error.message}`);
    return false;
  }
}

/**
 * 选 Java：设置里指定了就用指定的，否则按版本 JSON 要求挑一个。
 * @param {{requiredMajor:number, versionId?:string}} options
 */
async function resolveJavaRuntime(options = {}) {
  const requiredMajor = Number(options.requiredMajor) || 0;
  const settings = await readSettings();

  if (settings.javaPath) {
    const info = await javaRuntime.probe(settings.javaPath);
    if (info) {
      if (requiredMajor && info.major < requiredMajor) {
        console.warn(`[launch] configured Java ${info.major} is below required ${requiredMajor}`);
      }
      return info;
    }
    console.warn('[launch] configured Java unusable, falling back to auto detect:', settings.javaPath);
  }

  const runtimes = await javaRuntime.getJavaRuntimes(mcdl);
  const picked = javaRuntime.pickJava(runtimes, requiredMajor);
  return picked || null;
}

function aliasFile() {
  return path.join(app.getPath('userData'), 'instance-display-names.json');
}

async function readAliases() {
  try {
    const raw = await fs.readFile(aliasFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAliases(aliases) {
  const file = aliasFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(aliases, null, 2), 'utf8');
}

function scanCacheFile() {
  return path.join(app.getPath('userData'), 'scanned-game-dirs.json');
}

async function readScanCache() {
  try {
    const raw = await fs.readFile(scanCacheFile(), 'utf8');
    const parsed = JSON.parse(raw);
    const dirs = Array.isArray(parsed) ? parsed : parsed && parsed.dirs;
    return Array.isArray(dirs)
      ? dirs.filter((dir) => typeof dir === 'string' && dir.trim()).map((dir) => path.resolve(dir))
      : [];
  } catch {
    return [];
  }
}

async function writeScanCache(dirs) {
  const file = scanCacheFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    dirs,
    updatedAt: new Date().toISOString()
  }, null, 2), 'utf8');
}

function uniqueDirs(dirs) {
  const seen = new Set();
  const result = [];
  for (const dir of dirs) {
    if (!dir) continue;
    const resolved = path.resolve(dir);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

/**
 * 默认只扫描 MCDL Launcher 自己的游戏目录；
 * externalDirs 只会来自用户主动扫描后的缓存。
 */
async function buildInstanceSnapshot(ownDir, externalDirs = []) {
  const aliases = await readAliases();
  const ownKey = path.resolve(ownDir).toLowerCase();
  const cleanExternalDirs = uniqueDirs(externalDirs)
    .filter((dir) => path.resolve(dir).toLowerCase() !== ownKey);
  const primary = await mcdl.scanInstances(ownDir, aliases, { primary: true });
  const instances = primary.instances.slice();
  let selectedId = primary.selectedId;

  for (const dir of cleanExternalDirs) {
    const snapshot = await mcdl.scanInstances(dir, aliases, { primary: false });
    instances.push(...snapshot.instances);
    if (!selectedId && snapshot.selectedId) selectedId = snapshot.selectedId;
  }

  return {
    gameDir: primary.gameDir,
    instances,
    selectedId,
    scanDirs: [primary.gameDir, ...cleanExternalDirs],
    cachedDirs: cleanExternalDirs
  };
}

function sendInstallOutput(win, bufferState) {
  return (text) => {
    bufferState.value += String(text);
    const parts = bufferState.value.split(/\r\n|\n|\r/);
    bufferState.value = parts.pop() || '';

    for (const part of parts) {
      const message = part.trim();
      if (!message) continue;
      if (!win.isDestroyed()) {
        win.webContents.send('instances:install-progress', { message });
      }
    }
  };
}

/**
 * Only the app's own renderer may call these IPC handlers.
 */
function assertAppWindow(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Unauthorized IPC sender');
  }
  return mainWindow;
}

function registerIpcHandlers() {
  ipcMain.handle('window:minimize', (event) => {
    const win = assertAppWindow(event);
    win.minimize();
    return true;
  });

  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = assertAppWindow(event);
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return win.isMaximized();
  });

  ipcMain.handle('window:close', (event) => {
    const win = assertAppWindow(event);
    setImmediate(() => {
      if (!win.isDestroyed()) win.close();
    });
    return true;
  });

  ipcMain.handle('window:is-maximized', (event) => {
    return assertAppWindow(event).isMaximized();
  });

  ipcMain.handle('instances:list', async (event) => {
    assertAppWindow(event);
    try {
      const ownDir = await mcdl.detectGameDir();
      const cachedDirs = await readScanCache();
      return await buildInstanceSnapshot(ownDir, cachedDirs);
    } catch (error) {
      console.error('[instance-data] failed to read instances:', error);
      throw new Error(`无法读取实例数据: ${error.message}`);
    }
  });

  ipcMain.handle('instances:scan-other', async (event) => {
    assertAppWindow(event);
    try {
      const ownDir = await mcdl.detectGameDir();
      const cachedDirs = await readScanCache();
      const foundDirs = await mcdl.findOtherGameDirs();
      const mergedDirs = uniqueDirs([...cachedDirs, ...foundDirs])
        .filter((dir) => dir.toLowerCase() !== ownDir.toLowerCase());

      let cachePersisted = true;
      try {
        await writeScanCache(mergedDirs);
      } catch (error) {
        cachePersisted = false;
        console.warn('[instances] could not persist scan cache:', error);
      }

      const snapshot = await buildInstanceSnapshot(ownDir, mergedDirs);
      snapshot.newlyScanned = foundDirs.length;
      snapshot.scanCache = mergedDirs;
      snapshot.cachePersisted = cachePersisted;
      return snapshot;
    } catch (error) {
      console.error('[instances] scan other launchers failed:', error);
      throw new Error(`扫描其他启动器实例失败: ${error.message}`);
    }
  });

  ipcMain.handle('versions:list', async (event) => {
    assertAppWindow(event);
    try {
      return await mcdl.listVersions();
    } catch (error) {
      console.error('[versions] failed to list versions:', error);
      throw new Error(`无法读取版本列表: ${error.message}`);
    }
  });

  ipcMain.handle('instances:create', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const version = String(payload.version || '').trim();
    const loader = String(payload.loader || 'Vanilla');
    const requestedName = String(payload.name || '').trim();

    if (!version) throw new Error('缺少游戏版本');
    if (loader !== 'Vanilla') {
      throw new Error('当前 mcdl 后端仅支持原版安装，加载器安装尚未接入');
    }

    const gameDir = await mcdl.detectGameDir();
    const aliases = await readAliases();
    const cachedDirs = await readScanCache();
    const bufferState = { value: '' };

    if (!win.isDestroyed()) {
      win.webContents.send('instances:install-progress', {
        message: `准备安装 ${version} …`
      });
    }

    try {
      await mcdl.installVersion({
        version,
        gameDir,
        onData: sendInstallOutput(win, bufferState)
      });

      const versionDir = path.join(gameDir, 'versions', version);
      aliases[versionDir] = requestedName || aliases[versionDir] || `${version} · 原版`;
      try {
        await writeAliases(aliases);
      } catch (error) {
        console.warn('[instances] could not persist display name:', error);
      }

      const snapshot = await buildInstanceSnapshot(gameDir, cachedDirs);
      snapshot.selectedId = version;

      if (!win.isDestroyed()) {
        win.webContents.send('instances:install-progress', {
          message: `安装完成：${version}`
        });
      }

      return snapshot;
    } catch (error) {
      console.error('[instances] mcdl install failed:', error);
      if (error && error.stdout) {
        console.error('[instances] mcdl stdout tail:\n' + String(error.stdout).split(/\r?\n/).slice(-30).join('\n'));
      }
      if (error && error.stderr) {
        console.error('[instances] mcdl stderr tail:\n' + String(error.stderr).split(/\r?\n/).slice(-30).join('\n'));
      }
      if (!win.isDestroyed()) {
        win.webContents.send('instances:install-progress', {
          message: `安装失败：${error.message}`
        });
      }
      throw error;
    }
  });

  ipcMain.handle('shell:open-logs', async (event) => {
    assertAppWindow(event);
    const logDirectory = app.getPath('logs');
    await fs.mkdir(logDirectory, { recursive: true });
    const error = await shell.openPath(logDirectory);
    if (error) throw new Error(error);
    return true;
  });

  /**
   * 弹窗里的「可点击面板」用它打开外部帮助页。
   * 只允许 http(s)，避免渲染进程借这个通道打开任意本地程序。
   */
  ipcMain.handle('shell:open-external', async (event, url) => {
    assertAppWindow(event);
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) {
      throw new Error('只允许打开 http(s) 链接');
    }
    await shell.openExternal(target);
    return true;
  });

  /**
   * 真实启动：按版本 JSON 拼 java 命令并拉起游戏进程。
   */
  ipcMain.handle('launcher:launch', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const instanceId =
      payload && typeof payload.instanceId === 'string' ? payload.instanceId : null;

    const send = (data) => {
      if (!win.isDestroyed()) {
        win.webContents.send('launcher:launch-progress', { instanceId, at: Date.now(), ...data });
      }
    };

    try {
      const ownDir = await mcdl.detectGameDir();
      const cachedDirs = await readScanCache();
      const snapshot = await buildInstanceSnapshot(ownDir, cachedDirs);
      const instance =
        snapshot.instances.find((item) => item.id === instanceId) ||
        snapshot.instances.find((item) => item.id === snapshot.selectedId);

      if (!instance) throw new Error('没有可启动的实例，请先创建一个实例');

      const versionId = path.basename(instance.path);
      const gameDir = instance.gameDir || ownDir;

      const store = getAccountStore();
      let account = await store.getSelected();
      if (!account) {
        throw new Error('还没有选择账号，请先在「账户」页创建离线账号或登录微软账号');
      }

      if (account.type === 'microsoft') {
        try {
          const refreshed = await accounts.ensureFreshToken(account);
          if (refreshed.accessToken !== account.accessToken) {
            await store.save(refreshed);
          }
          account = refreshed;
        } catch (error) {
          throw new Error(`微软账号令牌已失效，请重新登录：${error.message}`);
        }
      }

      const settings = await readSettings();

      send({ phase: 'starting', instanceId, versionId, memoryMb: settings.memoryMb });

      const result = await launcher.launchInstance({
        gameDir,
        instanceId: versionId,
        account,
        settings,
        resolveJava: (options) => resolveJavaRuntime(options),
        onEvent: (kind, data) => {
          if (kind === 'output') {
            send({ phase: 'output', stream: data.stream, text: data.text });
            return;
          }
          send({ phase: kind, ...data });
        }
      });

      await store.markUsed(account.id).catch(() => {});

      return {
        ok: true,
        instanceId,
        versionId: result.plan.versionId,
        launchId: result.launchId,
        pid: result.pid,
        javaPath: result.plan.javaPath,
        javaMajor: result.plan.javaMajor,
        memoryMb: result.plan.memoryMb,
        logFile: result.logFile,
        warnings: result.plan.warnings
      };
    } catch (error) {
      console.error('[launch] failed:', error);
      send({ phase: 'error', message: error.message });
      throw error;
    }
  });

  ipcMain.handle('launcher:stop', async (event, launchId) => {
    assertAppWindow(event);
    return launcher.stopLaunch(String(launchId || ''));
  });

  ipcMain.handle('launcher:active', async (event) => {
    assertAppWindow(event);
    return launcher.listActiveLaunches();
  });

  // ---------------- 账户 ----------------

  ipcMain.handle('accounts:list', async (event) => {
    assertAppWindow(event);
    const result = await getAccountStore().list();
    return {
      accounts: result.accounts,
      selectedId: result.selectedId,
      servers: result.servers
    };
  });

  ipcMain.handle('accounts:add-offline', async (event, payload = {}) => {
    assertAppWindow(event);
    await getAccountStore().addOffline(payload && payload.name);
    return getAccountStore().list();
  });

  ipcMain.handle('accounts:add-microsoft', async (event) => {
    const win = assertAppWindow(event);
    try {
      const code = await accounts.requestAuthorizationCode(win);
      const details = await accounts.completeMicrosoftLogin(code);
      await getAccountStore().addMicrosoft(details);
      const list = await getAccountStore().list();
      return list;
    } catch (error) {
      console.error('[accounts] microsoft login failed:', error);
      throw new Error(`微软登录失败：${error.message}`);
    }
  });

  ipcMain.handle('accounts:select', async (event, id) => {
    assertAppWindow(event);
    await getAccountStore().select(String(id || ''));
    return getAccountStore().list();
  });

  ipcMain.handle('accounts:remove', async (event, id) => {
    assertAppWindow(event);
    await getAccountStore().remove(String(id || ''));
    return getAccountStore().list();
  });

  // ---- 第三方认证服务器（authlib-injector）----

  ipcMain.handle('accounts:servers', async (event) => {
    assertAppWindow(event);
    return getAccountStore().listServers();
  });

  ipcMain.handle('accounts:add-server', async (event, payload = {}) => {
    assertAppWindow(event);
    return getAccountStore().addServer(payload && payload.apiRoot);
  });

  ipcMain.handle('accounts:remove-server', async (event, id) => {
    assertAppWindow(event);
    return getAccountStore().removeServer(String(id || ''));
  });

  ipcMain.handle('accounts:login-authlib', async (event, payload = {}) => {
    assertAppWindow(event);
    try {
      return await getAccountStore().addAuthlib({
        serverId: String(payload.serverId || ''),
        username: payload.username,
        password: payload.password
      });
    } catch (error) {
      console.error('[accounts] authlib login failed:', error);
      throw error;
    }
  });

  // ---- 离线皮肤 ----

  ipcMain.handle('accounts:pick-skin', async (event) => {
    const win = assertAppWindow(event);
    const result = await dialog.showOpenDialog(win, {
      title: '选择皮肤文件',
      buttonLabel: '选择',
      filters: [{ name: 'Minecraft 皮肤 (PNG)', extensions: ['png'] }],
      properties: ['openFile']
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;

    const filePath = result.filePaths[0];
    const info = await readSkinPng(filePath);
    return { filePath, ...info };
  });

  ipcMain.handle('accounts:set-skin', async (event, payload = {}) => {
    assertAppWindow(event);
    const id = String(payload.id || '');
    const sourcePath = String(payload.sourcePath || '');
    if (!sourcePath) throw new Error('请先选择皮肤文件');

    // 复制前再校验一次，避免把任意文件写进数据目录。
    await readSkinPng(sourcePath);
    const account = await getAccountStore().setSkin(id, { sourcePath, model: payload.model });
    const scope = await readSkinData(id);
    return { account, skin: scope };
  });

  ipcMain.handle('accounts:clear-skin', async (event, id) => {
    assertAppWindow(event);
    return getAccountStore().clearSkin(String(id || ''));
  });

  ipcMain.handle('accounts:set-skin-model', async (event, payload = {}) => {
    assertAppWindow(event);
    return getAccountStore().setSkinModel(String(payload.id || ''), payload.model);
  });

  ipcMain.handle('accounts:skin-data', async (event, id) => {
    assertAppWindow(event);
    return readSkinData(String(id || ''));
  });

  // ---------------- 设置 ----------------

  ipcMain.handle('settings:get', async (event) => {
    assertAppWindow(event);
    const settings = await readSettings();
    let javaRuntimes = [];
    try {
      javaRuntimes = await javaRuntime.getJavaRuntimes(mcdl);
    } catch (error) {
      console.warn('[settings] java scan failed:', error.message);
    }
    return {
      settings,
      javaRuntimes,
      defaultMemoryMb: launcher.defaultMemoryMb()
    };
  });

  ipcMain.handle('settings:save', async (event, patch = {}) => {
    assertAppWindow(event);
    return writeSettings(patch || {});
  });

  /**
   * 渲染模式：渲染进程据此启用软件渲染下的降级样式（去掉每帧重算的 blur）。
   */
  ipcMain.handle('env:render-mode', async (event) => {
    assertAppWindow(event);

    let gpuFeatureStatus = null;
    try {
      gpuFeatureStatus = app.getGPUFeatureStatus();
    } catch (error) {
      console.warn('[gpu] cannot read GPU status:', error.message);
    }

    return {
      mode: RENDER_MODE,
      software: RENDER_MODE === 'software',
      gpuFeatureStatus,
      crashMarker: readGpuCrashMarker()
    };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    show: false,
    title: 'MCDL Launcher',
    autoHideMenuBar: true,
    // 去掉 Windows 无边框窗口默认保留的厚边框/缩放区与外部阴影，
    // 否则页面内容与窗口外沿之间会出现一圈深色空隙。
    thickFrame: false,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[main] preload failed:', preloadPath, error);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[main] renderer failed to load:', errorCode, errorDescription, validatedURL);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] renderer process gone:', details);
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
    .catch((error) => {
      console.error('[main] loadFile failed:', error);
    });

  mainWindow.once('ready-to-show', () => {
    console.log('[main] window ready to show');
    mainWindow.show();
  });

  mainWindow.on('maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:maximized-changed', true);
  });

  mainWindow.on('unmaximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:maximized-changed', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
    }
  });

  if (IS_DEV) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// 单实例：多个实例会共享同一份 userData（账号 / 设置 / Chromium profile），
// 互相抢文件句柄时会表现为 EPERM 之类的写入失败，因此默认强制单实例。
// 调试时可以用 --multi-instance 显式放开。
function userDataWritableSync() {
  const dir = app.getPath('userData');
  const probe = path.join(dir, '.write-probe');
  try {
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(probe, '1', 'utf8');
    fsSync.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

const allowMultipleInstances = process.argv.includes('--multi-instance');
let gotSingleInstanceLock = allowMultipleInstances ? true : app.requestSingleInstanceLock();

// 数据目录不可写时单实例锁本身也建不起来，此时不能让它把启动挡掉。
if (!gotSingleInstanceLock && !allowMultipleInstances) {
  if (userDataWritableSync()) {
    console.warn('[main] another instance is already running');
  } else {
    console.warn('[main] cannot create instance lock (data dir not writable); starting anyway');
    gotSingleInstanceLock = true;
  }
}

console.log(`[main] single instance lock: ${gotSingleInstanceLock} (packaged=${app.isPackaged})`);

if (!gotSingleInstanceLock) {
  console.warn('[main] another instance is already running; focus it from the taskbar.');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    console.log('[main] app ready');

    if (process.platform === 'win32') {
      app.setAppUserModelId('com.mcdl.launcher');
    }

    // 无边框窗口下移除 Electron 默认菜单栏
    Menu.setApplicationMenu(null);

    registerIpcHandlers();
    createWindow();

    console.log('[main] BrowserWindow created');
    console.log(`[mcdl] jar: ${mcdl.MCDL_JAR}`);
    console.log(`[mcdl] default game dir: ${mcdl.DEFAULT_GAME_DIR}`);

    checkUserDataWritable().catch(() => {});

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
