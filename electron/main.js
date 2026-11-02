'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, dialog, session: electronSession } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const mcdl = require('./mcdl-service');
const modrinth = require('./modrinth');
const worlds = require('./worlds');
const javaRuntime = require('./java-runtime');
const launcher = require('./launch');
const accounts = require('./accounts');
const { createGameDirectoryStore } = require('./game-directories');
const { createInstanceStore } = require('./instance-store');
const pathGuard = require('./path-guard');
const launchScript = require('./launch-script');
const modpackGuard = require('./modpack-guard');

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

/** 远程皮肤缓存的有效期：过期后重新下载，失败时退回旧缓存。 */
const SKIN_CACHE_TTL = 6 * 60 * 60 * 1000;

function skinCacheFile(accountId, url) {
  const hash = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 10);
  const safeId = String(accountId).replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(app.getPath('userData'), 'skins', `remote-${safeId}-${hash}.png`);
}

/**
 * 找出账号的远程皮肤地址：
 *   - 微软账号：先读已存的 skinUrl，没有就用 accessToken 拉一次 /minecraft/profile
 *   - 第三方账号：向 session server 要 textures 属性
 */
async function resolveRemoteSkin(account) {
  const store = getAccountStore();

  if (account.skinUrl) {
    return { url: account.skinUrl, model: account.skinModel || 'classic' };
  }

  if (account.type === 'microsoft') {
    const info = await accounts.refreshMicrosoftSkin(account);
    if (!info || !info.skinUrl) return null;
    await store
      .save({
        id: account.id,
        skinUrl: info.skinUrl,
        skinModel: info.skinModel,
        skinFetchedAt: Date.now(),
        accessToken: info.accessToken || account.accessToken
      })
      .catch((error) => console.warn('[skin] 保存微软皮肤地址失败:', error.message));
    return { url: info.skinUrl, model: info.skinModel };
  }

  if (account.type === 'authlib') {
    const info = await accounts.fetchAuthlibSkin(account.serverApiRoot, account.uuid);
    if (!info || !info.url) return null;
    await store
      .save({ id: account.id, skinUrl: info.url, skinModel: info.model, skinFetchedAt: Date.now() })
      .catch((error) => console.warn('[skin] 保存服务器皮肤地址失败:', error.message));
    return { url: info.url, model: info.model };
  }

  return null;
}

async function readCachedSkin(file) {
  try {
    const buffer = await fs.readFile(file);
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

async function downloadSkin(url, file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(file, buffer);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

/**
 * 渲染进程要的皮肤图：
 *   1. 本机皮肤文件（离线账号手动选的）优先
 *   2. 否则走远程皮肤（微软 / 认证服务器），下载后缓存到数据目录
 */
async function readSkinData(id) {
  if (!id) return { dataUrl: null, model: 'classic', source: null };

  const store = getAccountStore();

  const localFile = await store.getSkinPath(id);
  if (localFile) {
    const buffer = await readCachedSkin(localFile);
    if (buffer) return { dataUrl: buffer, model: null, source: 'local' };
  }

  const account = await store.getById(id);
  if (!account) return { dataUrl: null, model: 'classic', source: null };

  const fallbackModel = account.skinModel || 'classic';

  let remote;
  try {
    remote = await resolveRemoteSkin(account);
  } catch (error) {
    console.warn('[skin] 获取远程皮肤地址失败:', error.message);
    return { dataUrl: null, model: fallbackModel, source: null };
  }

  if (!remote || !remote.url) return { dataUrl: null, model: fallbackModel, source: null };

  const file = skinCacheFile(account.id, remote.url);

  let stat = null;
  try {
    stat = await fs.stat(file);
  } catch {
    stat = null;
  }

  if (stat && Date.now() - stat.mtimeMs < SKIN_CACHE_TTL) {
    const cached = await readCachedSkin(file);
    if (cached) return { dataUrl: cached, model: remote.model, source: 'remote' };
  }

  try {
    const dataUrl = await downloadSkin(remote.url, file);
    return { dataUrl, model: remote.model, source: 'remote' };
  } catch (error) {
    console.warn('[skin] 下载皮肤失败:', error.message);
    const cached = stat ? await readCachedSkin(file) : null;
    return { dataUrl: cached, model: remote.model, source: cached ? 'remote-cache' : null };
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

const DEFAULT_EXTRA_SETTINGS = {
  gameIsolation: 'auto',       // auto | isolated | global
  disableAprilFools: false,
  language: 'zh-CN',
  versionListSource: 'auto',   // auto | official | bmclapi
  downloadSource: 'auto',
  addonSource: 'modrinth',     // modrinth（curseforge 需要 API Key）
  disableAnimations: false
};

const ISOLATION_MODES = new Set(['auto', 'isolated', 'global']);
const ADDON_SOURCES = new Set(['modrinth']);

function normalizeExtraSettings(raw) {
  const source = (value, fallback) => {
    const key = String(value || '').trim().toLowerCase();
    return ['auto', 'official', 'bmclapi'].includes(key) ? key : fallback;
  };
  const isolation = String(raw.gameIsolation || '').trim();
  const addon = String(raw.addonSource || '').trim().toLowerCase();

  return {
    gameIsolation: ISOLATION_MODES.has(isolation) ? isolation : 'auto',
    disableAprilFools: Boolean(raw.disableAprilFools),
    language: 'zh-CN',
    versionListSource: source(raw.versionListSource, 'auto'),
    downloadSource: source(raw.downloadSource, 'auto'),
    addonSource: ADDON_SOURCES.has(addon) ? addon : 'modrinth',
    disableAnimations: Boolean(raw.disableAnimations)
  };
}

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
    javaPath: normalized.javaPath,
    ...normalizeExtraSettings({ ...DEFAULT_EXTRA_SETTINGS, ...raw })
  };
}

/** 授权指纹：只写盘、不读给渲染进程（渲染进程只需要 javaPath）。 */
async function readJavaIdentity() {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    return raw && typeof raw.javaIdentity === 'object' ? raw.javaIdentity : null;
  } catch {
    return null;
  }
}

async function writeSettings(patch) {
  const current = await readSettings();
  const merged = launcher.normalizeSettings({ ...current, ...patch });
  const next = {
    memoryMb: merged.memoryMb,
    width: merged.width,
    height: merged.height,
    jvmArgs: merged.jvmArgs,
    javaPath: merged.javaPath,
    ...normalizeExtraSettings({ ...current, ...patch })
  };

  // javaPath 会直接变成 spawn 的目标：换了值就必须过授权（对话框登记过 / 启动器自己枚举到的），
  // 否则渲染进程（或一次 XSS）只要写设置就能让启动器执行任意程序。
  let javaIdentity = await readJavaIdentity();
  if (next.javaPath && next.javaPath !== current.javaPath) {
    const selected = await javaRuntime.assertJavaSelection(next.javaPath);
    next.javaPath = selected.real;
    javaIdentity = await javaRuntime.javaAuthorization(selected.real);
  } else if (!next.javaPath) {
    javaIdentity = null;
  } else if (!javaIdentity) {
    // 老配置里只有路径没有指纹：补一次登记（路径必须已被授权或来自启动器枚举）。
    await javaRuntime.assertJavaSelection(next.javaPath);
    javaIdentity = await javaRuntime.javaAuthorization(next.javaPath);
  }

  const file = settingsFile();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      ...next,
      javaIdentity: javaIdentity || null
    }, null, 2), 'utf8');
  } catch (error) {
    throw new Error(
      `无法写入设置文件（${error.code || 'ERROR'}）：${file}\n` +
      '请确认该目录可写，并关闭其他正在运行的启动器实例后重试'
    );
  }

  applySettingsSideEffects(next);
  return next;
}

/** 把设置里影响其他模块的项同步过去（内容目录隔离策略）。 */
function applySettingsSideEffects(settings) {
  try {
    getInstanceStore().setIsolationMode(settings && settings.gameIsolation);
  } catch (error) {
    console.warn('[settings] could not apply isolation mode:', error.message);
  }
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
/**
 * 选 Java：实例级设置 > 全局设置 > 自动探测。
 * @param {{requiredMajor:number, versionId?:string, javaPath?:string}} options
 */
async function resolveJavaRuntime(options = {}) {
  const requiredMajor = Number(options.requiredMajor) || 0;
  const settings = await readSettings();
  // 实例级 Java 优先（由调用方把 effective settings 的 javaPath 传进来）。
  const javaPath = String(options.javaPath || settings.javaPath || '');

  if (javaPath) {
    // 使用点校验：已授权的直接用缓存信息（不执行），未授权的只有在启动器自己枚举到的
    // 目录里才允许 probe 一次入表，其余一律拒绝。
    //
    // 注意这里**不再静默回退自动探测**：用户明确选了 JDK 21 却被悄悄换成 JDK 17，
    // 表现为"某个版本莫名崩"，比直接报错误导得多。
    const info = await javaRuntime.assertUsableJava(javaPath).catch((error) => {
      throw new Error(
        `设置的 Java 不可用：${error.message}\n` +
          '请到「设置 → Java」重新选择，或清空该选项改用自动探测。'
      );
    });

    if (requiredMajor && info.major < requiredMajor) {
      console.warn(`[launch] configured Java ${info.major} is below required ${requiredMajor}`);
    }
    return info;
  }

  const runtimes = await javaRuntime.getJavaRuntimes(mcdl, { cacheFile: javaRuntimeCacheFile() });
  const picked = javaRuntime.pickJava(runtimes, requiredMajor);
  return picked || null;
}

function javaRuntimeCacheFile() {
  return path.join(app.getPath('userData'), 'java-runtimes.json');
}

function aliasFile() {
  return path.join(app.getPath('userData'), 'instance-display-names.json');
}

// ---------------- 实例级数据（设置 / 图标 / 内容） ----------------

let instanceStore = null;

function getInstanceStore() {
  if (!instanceStore) {
    instanceStore = createInstanceStore({
      storeDir: app.getPath('userData'),
      launcherHome: mcdl.LAUNCHER_HOME
    });
  }
  return instanceStore;
}

/**
 * 生效设置 = 全局设置 + 实例覆盖（实例优先）。
 * 内存 / 窗口尺寸 / JVM 参数 / Java 路径都可以按实例覆盖。
 */
async function effectiveSettings(versionDir) {
  const globalSettings = await readSettings();
  let overrides = {};
  try {
    if (versionDir) overrides = await getInstanceStore().getSettings(versionDir);
  } catch (error) {
    console.warn('[instance] read instance settings failed:', error.message);
  }
  const merged = launcher.normalizeSettings({ ...globalSettings, ...overrides });
  return {
    memoryMb: merged.memoryMb,
    width: merged.width,
    height: merged.height,
    jvmArgs: overrides.jvmArgs || globalSettings.jvmArgs || '',
    javaPath: overrides.javaPath || globalSettings.javaPath || ''
  };
}

// ---------------- 游戏目录管理 ----------------

let gameDirStore = null;

function getGameDirStore() {
  if (!gameDirStore) {
    gameDirStore = createGameDirectoryStore({
      storeDir: app.getPath('userData'),
      defaultDir: mcdl.DEFAULT_GAME_DIR,
      launcherHome: mcdl.LAUNCHER_HOME
    });
  }
  return gameDirStore;
}

/** 资源管理器可执行文件：优先用绝对路径，避免 PATH 里找不到。 */
function explorerExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const absolute = path.join(root, 'explorer.exe');
  try {
    fsSync.accessSync(absolute);
    return absolute;
  } catch {
    return 'explorer.exe';
  }
}

/**
 * 拉起一个和主进程解耦的 GUI 程序（explorer.exe），并等它真的启动成功。
 *
 * 坑：spawn() 在「可执行文件不存在 / 没有执行权限」时**不会抛异常**，而是在下一个
 * tick 异步 emit('error')。没人监听时会变成未捕获异常，直接带走主进程（Electron
 * 会弹「A JavaScript error occurred in the main process」，看起来就像启动器崩了）。
 * 所以 try/catch 包 spawn 是假保护，必须等 'spawn' / 'error' 其中一个。
 */
function spawnDetached(exe, args) {
  return new Promise((resolve, reject) => {
    let child = null;
    try {
      child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', (error) => reject(error));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * 确认目录在 Windows 这一层真的能「进去」。
 *
 * 不能用 fs.access(path, R_OK)：Windows 上它只看文件属性，一个被 ACL 拒绝列目录的
 * 文件夹照样返回成功（实测 deny RX 的目录 access=R_OK 通过、readdir=EPERM）。
 * opendir 需要目录的 LIST 权限，正好等于资源管理器打开它所需的那一项，而且不枚举内容。
 */
async function assertFolderReadable(target) {
  try {
    const handle = await fs.opendir(target);
    await handle.close();
    return;
  } catch (error) {
    // 真没权限时给可操作的提示，别把用户丢给 Windows 的原生弹窗
    throw new Error(
      `无法访问这个文件夹（${error.code || error.message}）：${target}\n` +
        '可能是权限限制或安全软件拦截。可以在资源管理器里手动打开该路径确认。'
    );
  }
}

/**
 * 当前进程是不是跑在「低完整性级别」（Low IL）里。
 *
 * 从沙箱 / 受限终端 / 某些安全软件里启动时，进程令牌的完整性级别会低于桌面外壳，
 * 而 Windows 的 shell 交接受 UIPI 约束：低完整性进程发出的「打开这个文件夹」请求
 * 交不到中完整性的资源管理器，表现为**点了按钮什么也不发生**，或者系统弹
 * 「Windows 无法访问指定设备、路径或文件」。
 *
 * 判断方式用 `whoami /groups` 里的 SID（S-1-16-4096 = Low），不看本地化文案。
 * 探测失败一律当作正常，不能让探测本身影响功能。
 */
let integrityProbe = null;

function isLowIntegrity() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  if (!integrityProbe) {
    integrityProbe = new Promise((resolve) => {
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
      execFile(exe, ['/groups'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        if (error || !stdout) return resolve(false);
        resolve(/\bS-1-16-4096\b/.test(String(stdout)));
      });
    });
  }
  return integrityProbe;
}

/**
 * 低完整性级别下，任何「把路径交给资源管理器」的做法都会静默失败：
 * spawn explorer.exe 会继承低完整性令牌、交接受阻；ShellExecute 一侧则可能直接
 * 返回 ERROR_ACCESS_DENIED。与其让用户面对一个没反应的按钮，不如先说明原因。
 */
async function assertShellHandoffAvailable(target) {
  if (!(await isLowIntegrity())) return;
  throw new Error(
    '启动器运行在低完整性级别（Low IL），Windows 会拒绝它把路径交给资源管理器，所以点了没反应。' +
      '多半是 electron.exe 所在目录被打了 Low 完整性标签：用 icacls 查看该 exe，' +
      '执行 icacls "<目录>" /setintegritylevel M /T 重置后完全退出重启（见 docs/troubleshooting.md）。' +
      `\n${target}`
  );
}

/**
 * 用资源管理器打开文件夹。
 *
 * 不用 shell.openPath 直接了事的原因：
 *   - 目录不存在 / 设备不可达时它会调起 ShellExecuteEx，失败面由 Windows 外壳决定，
 *     用户可能只看到一个原生弹窗（「Windows 无法访问指定设备、路径或文件」），而
 *     调用方还以为成功了；
 *   - 进程和 explorer 不在同一个权限上下文时（比如启动器被以管理员启动），
 *     ShellExecute 的 DDE 交接触发失败。
 * 所以先保证目录存在且可读，Windows 上直接拉起 explorer.exe，再退回 shell.openPath。
 */
async function openFolderPath(dir) {
  // 这里会真的去 fs.stat / mkdir / 交给资源管理器，所以必须先拒掉 UNC 与设备路径：
  // `\\attacker\share` 在 stat 那一刻就会让 Windows 发 SMB 认证。
  const target = pathGuard.assertLocalPath(dir, '文件夹路径');

  let stat = null;
  try {
    stat = await fs.stat(target);
  } catch {
    stat = null;
  }

  if (!stat) {
    try {
      await fs.mkdir(target, { recursive: true });
    } catch (error) {
      throw new Error(`文件夹不存在，也无法创建（${error.code || error.message}）：${target}`);
    }
  } else if (!stat.isDirectory()) {
    throw new Error(`这不是文件夹：${target}`);
  }

  await assertFolderReadable(target);
  await assertShellHandoffAvailable(target);

  let shellError = null;
  if (process.platform === 'win32') {
    try {
      await spawnDetached(explorerExe(), [target]);
      return target;
    } catch (error) {
      shellError = error;
      console.warn('[open-folder] explorer 启动失败，回退 shell.openPath：', error.code || error.message);
    }
  }

  const error = await shell.openPath(target);
  if (error) {
    const detail = shellError ? `\n（explorer.exe 也启动失败：${shellError.code || shellError.message}）` : '';
    throw new Error(`无法打开文件夹：${error}\n${target}${detail}`);
  }
  return target;
}

/** 在资源管理器里定位文件；文件不存在时给出明确错误，而不是假装成功。 */
async function revealPath(filePath) {
  const target = pathGuard.assertLocalPath(filePath, '文件路径');

  let stat = null;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new Error(`文件不存在，可能已被移动或删除：${target}`);
  }

  if (stat.isDirectory()) return openFolderPath(target);

  await assertShellHandoffAvailable(target);

  let shellError = null;
  if (process.platform === 'win32') {
    try {
      // explorer.exe 的 /select 参数要拼成一个参数，路径里的逗号不用转义。
      await spawnDetached(explorerExe(), [`/select,${target}`]);
      return target;
    } catch (error) {
      shellError = error;
      console.warn('[reveal] explorer /select 失败，回退 openPath：', error.code || error.message);
    }
  }

  // 最后一道用 openPath 打开所在目录，而不是 showItemInFolder：
  // showItemInFolder 没有返回值，失败也看不出来，等于又回到「假装成功」。
  const error = await shell.openPath(path.dirname(target));
  if (error) {
    const detail = shellError ? `\n（explorer.exe 也启动失败：${shellError.code || shellError.message}）` : '';
    throw new Error(`无法定位文件：${error}\n${target}${detail}`);
  }
  return target;
}

/**
 * 当前被管理的所有游戏目录。
 * 启动器自己的目录始终作为主目录扫描，其余管理目录一律当作外部目录。
 */
async function managedGameDirs() {
  const paths = await getGameDirStore().paths();
  const own = path.resolve(mcdl.DEFAULT_GAME_DIR);
  const rest = paths.filter((dir) => path.resolve(dir).toLowerCase() !== own.toLowerCase());
  return { primary: own, dirs: rest };
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

/**
 * 按 id 找实例：扫描主目录 + 用户添加的游戏文件夹 + 已缓存的其他启动器目录。
 */
async function findInstance(instanceId) {
  const snapshot = await rescanInstances();
  return {
    snapshot,
    instance: snapshot.instances.find((item) => item.id === instanceId) || null
  };
}

/**
 * 给实例补上图标信息（内置图标只回 key，自定义图标回 data URL）。
 */
async function enrichInstanceIcons(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.instances)) return snapshot;

  const store = getInstanceStore();
  await Promise.all(snapshot.instances.map(async (instance) => {
    try {
      const { icon, dataUrl } = await store.iconData(instance.path);
      instance.iconKey = icon && icon.type === 'builtin' ? icon.key : '';
      instance.iconDataUrl = dataUrl || '';
    } catch {
      instance.iconKey = '';
      instance.iconDataUrl = '';
    }
  }));

  return snapshot;
}

async function rescanInstances(selectedId) {
  const ownDir = await mcdl.detectGameDir();
  const managed = await managedGameDirs();
  const cachedDirs = await readScanCache();
  const snapshot = await buildInstanceSnapshot(ownDir, uniqueDirs([...managed.dirs, ...cachedDirs]));
  snapshot.managedDirs = managed.dirs;
  if (selectedId) snapshot.selectedId = selectedId;
  return enrichInstanceIcons(snapshot);
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
 * Only the app's own renderer (main frame, local origin) may call these IPC handlers.
 *
 * 只比 event.sender 是不够的：同一窗口里任意子框架拿到的是同一个 webContents。
 * 现在没有 iframe / webview，但以后加上内嵌页面时这层就不成立了，所以顺手把
 * 主框架与来源一起钉死。
 */
function assertAppWindow(event) {
  const win = mainWindow;
  if (!win || win.isDestroyed() || event.sender !== win.webContents) {
    throw new Error('Unauthorized IPC sender');
  }

  const frame = event.senderFrame;
  if (!frame || frame !== win.webContents.mainFrame) {
    throw new Error('Unauthorized IPC frame');
  }
  if (!/^file:\/\//i.test(String(frame.url || ''))) {
    throw new Error('Unauthorized IPC origin');
  }

  return win;
}

/**
 * 「把某个路径交给资源管理器」的允许范围：只有启动器自己的数据目录、已登记的游戏目录。
 *
 * 三段式：先词法拒 UNC / 设备路径（`fs.stat` 会触发 SMB 认证），再对允许根与目标都取
 * realpath（junction 会解析到真实目标），最后才由调用方 mkdir / 打开。
 */
async function assertOpenablePath(raw) {
  const target = pathGuard.assertLocalPath(raw, '要打开的路径');
  const roots = [app.getPath('userData')];

  try {
    const managed = await managedGameDirs();
    roots.push(managed.primary, ...managed.dirs);
  } catch (error) {
    console.warn('[open-folder] 读取游戏目录失败，只允许数据目录内的路径:', error.message);
  }

  try {
    const store = getGameDirStore();
    roots.push(...(await store.paths()));
  } catch {
    // 读不到就按上面的范围来
  }

  return pathGuard.assertInsideAnyRoots(roots, target, '要打开的路径', { allowEqual: true });
}

/**
 * 实例显示名：去掉控制字符（换行 / 制表 / 零宽分隔符）并压掉多余空白。
 *
 * 这些名字会出现在界面、生成的启动脚本、以及各种导出文本里；控制字符没有任何
 * 正当用途，却能把"一行注释"变成"一条命令"。
 */
function sanitizeDisplayName(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
      const managed = await managedGameDirs();
      const cachedDirs = await readScanCache();
      // 扫描顺序：启动器自己的目录 → 用户添加的游戏文件夹 → 主动扫描过的其他启动器
      const externalDirs = uniqueDirs([...managed.dirs, ...cachedDirs]);
      const snapshot = await buildInstanceSnapshot(ownDir, externalDirs);
      snapshot.managedDirs = managed.dirs;
      return await enrichInstanceIcons(snapshot);
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
      const settings = await readSettings();
      return await mcdl.listVersions({ source: settings.versionListSource });
    } catch (error) {
      console.error('[versions] failed to list versions:', error);
      throw new Error(`无法读取版本列表: ${error.message}`);
    }
  });

  ipcMain.handle('loaders:list', async (event, payload = {}) => {
    assertAppWindow(event);
    const loader = String(payload.loader || '').trim();
    const mcVersion = String(payload.mcVersion || payload.version || '').trim();
    try {
      const settings = await readSettings();
      return await mcdl.listLoaders({ loader, mcVersion, source: settings.downloadSource });
    } catch (error) {
      console.error('[loaders] failed to list loader versions:', error);
      throw new Error(`无法读取加载器版本: ${error.message}`);
    }
  });

  ipcMain.handle('instances:create', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const version = String(payload.version || '').trim();
    const loader = String(payload.loader || 'Vanilla');
    const loaderVersion = String(payload.loaderVersion || '').trim();
    const requestedName = sanitizeDisplayName(payload.name);

    if (!version) throw new Error('缺少游戏版本');
    const vanilla = loader === 'Vanilla' || loader === '' || loader === 'vanilla';
    if (!vanilla && !mcdl.isSupportedLoader(loader)) {
      throw new Error(`不支持的加载器：${loader}`);
    }

    const requestedDir = String(payload.gameDir || '').trim();
    let gameDir;
    if (requestedDir) {
      gameDir = pathGuard.assertLocalPath(requestedDir, '游戏目录');
      const stat = await fs.stat(gameDir).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        throw new Error(`游戏目录不存在：${gameDir}`);
      }
    } else {
      gameDir = await mcdl.detectGameDir();
    }
    const aliases = await readAliases();
    const cachedDirs = await readScanCache();
    const bufferState = { value: '' };
    const loaderLabel = vanilla ? '原版' : loader + (loaderVersion ? ' ' + loaderVersion : '');

    if (!win.isDestroyed()) {
      win.webContents.send('instances:install-progress', {
        message: `准备安装 ${version}${vanilla ? '' : ' + ' + loaderLabel} …`
      });
    }

    try {
      const settings = await readSettings();
      if (vanilla) {
        await mcdl.installVersion({
          version,
          gameDir,
          source: settings.downloadSource,
          assets: payload.assets !== false,
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
      }

      // 加载器：mcdl 会先确保原版，再生成 versions/<实例名> 并写入 inheritsFrom
      const result = await mcdl.installLoader({
        loader,
        loaderVersion,
        mcVersion: version,
        name: requestedName,
        gameDir,
        source: settings.downloadSource,
        onData: sendInstallOutput(win, bufferState)
      });

      // 重名时 mcdl 会给实例目录加 (2) 后缀，此时别名改用可读的默认名，避免两条同名实例
      aliases[result.instanceDir] = requestedName && result.instanceId === requestedName
        ? requestedName
        : `${version} · ${result.label || loader} ${result.loaderVersion || loaderVersion}`.trim();
      try {
        await writeAliases(aliases);
      } catch (error) {
        console.warn('[instances] could not persist display name:', error);
      }

      const snapshot = await buildInstanceSnapshot(gameDir, cachedDirs);
      snapshot.selectedId = result.instanceId;
      snapshot.createdInstanceId = result.instanceId;

      if (!win.isDestroyed()) {
        win.webContents.send('instances:install-progress', {
          message: `安装完成：${version} + ${result.label || loader} ${result.loaderVersion || loaderVersion}`
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

  // ---------------- 下载中心：版本目录 / 整合包 ----------------

  function sendDownloadOutput(win, bufferState) {
    return (text) => {
      bufferState.value += String(text);
      const parts = bufferState.value.split(/\r\n|\n|\r/);
      bufferState.value = parts.pop() || '';
      for (const part of parts) {
        const message = part.trim();
        if (!message) continue;
        if (!win.isDestroyed()) {
          win.webContents.send('downloads:progress', { message });
        }
      }
    };
  }

  ipcMain.handle('downloads:versions', async (event, payload = {}) => {
    assertAppWindow(event);
    try {
      const settings = await readSettings();
      return await mcdl.versionCatalog({
        force: Boolean(payload.force),
        source: settings.versionListSource
      });
    } catch (error) {
      console.error('[downloads] failed to list versions:', error);
      throw new Error(`无法读取版本列表: ${error.message}`);
    }
  });

  /**
   * 整合包预检：读条目 + 资源限制 + 链接条目检查，产出一次性安装许可（token）。
   * 对话框和拖拽走同一条管线——安全由"内容已过检"保证，而不是"路径从哪来"。
   */
  async function preparePack(file) {
    const prepared = await modpackGuard.prepare(file);

    let inspected = {};
    try {
      inspected = await mcdl.inspectModpack(prepared.info.path);
    } catch (error) {
      console.warn('[downloads] 读取整合包摘要失败（继续按预检结果处理）:', error.message);
    }

    return { ...inspected, ...prepared.info, token: prepared.token };
  }

  ipcMain.handle('downloads:pick-pack', async (event) => {
    const win = assertAppWindow(event);
    const result = await dialog.showOpenDialog(win, {
      title: '选择整合包',
      properties: ['openFile'],
      filters: [
        { name: 'Minecraft 整合包', extensions: ['zip', 'mrpack'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;

    try {
      return await preparePack(result.filePaths[0]);
    } catch (error) {
      throw new Error(`无法读取整合包: ${error.message}`);
    }
  });

  /** 拖拽入口：路径来自渲染进程，所以只做预检，不直接安装。 */
  ipcMain.handle('downloads:prepare-pack', async (event, payload = {}) => {
    assertAppWindow(event);
    try {
      return await preparePack(payload && payload.file);
    } catch (error) {
      throw new Error(`无法读取整合包: ${error.message}`);
    }
  });

  /** 兼容旧名字（等价于 prepare-pack）。 */
  ipcMain.handle('downloads:inspect-pack', async (event, payload = {}) => {
    assertAppWindow(event);
    try {
      return await preparePack(payload && payload.file);
    } catch (error) {
      throw new Error(`无法读取整合包: ${error.message}`);
    }
  });

  ipcMain.handle('downloads:install-pack', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    // 只认预检产出的 token，不认路径：拿不到 token 就装不了。
    const record = modpackGuard.consume(payload && payload.token);
    const requestedName = sanitizeDisplayName(payload.name);

    await modpackGuard.assertUnchanged(record);

    const gameDir = await mcdl.detectGameDir();
    const bufferState = { value: '' };
    const send = (message) => {
      if (!win.isDestroyed()) win.webContents.send('downloads:progress', { message });
    };

    send('准备安装整合包…');

    try {
      const result = await mcdl.installModpack({
        file: record.file,
        name: requestedName,
        gameDir,
        onData: sendDownloadOutput(win, bufferState)
      });

      // 解压后核对：不允许出现链接 / 指到目录外的条目（防"解压器某天被改坏"）。
      try {
        const checked = await modpackGuard.verifyExtractedTree(result.instanceDir);
        console.log(`[downloads] 解压核对通过：${checked.files} 个文件，${checked.bytes} 字节`);
      } catch (error) {
        console.error('[downloads] 解压结果未通过核对，已删除该实例：', error.message);
        await fs.rm(result.instanceDir, { recursive: true, force: true }).catch(() => {});
        send(`安装已中止：${error.message}`);
        throw error;
      }

      const aliases = await readAliases();
      aliases[path.resolve(result.instanceDir)] = requestedName || result.instanceId;
      try {
        await writeAliases(aliases);
      } catch (error) {
        console.warn('[downloads] could not persist display name:', error);
      }

      const cachedDirs = await readScanCache();
      const snapshot = await buildInstanceSnapshot(gameDir, cachedDirs);
      snapshot.selectedId = result.instanceId;

      send(`安装完成：${result.instanceId}`);
      return { ...result, snapshot };
    } catch (error) {
      console.error('[downloads] modpack install failed:', error);
      if (error && error.stdout) {
        console.error('[downloads] mcdl stdout tail:\n' + String(error.stdout).split(/\r?\n/).slice(-30).join('\n'));
      }
      send(`安装失败：${error.message}`);
      throw error;
    }
  });

  // ---------------- 世界（存档）管理 ----------------

  function backupsRoot() {
    return path.join(app.getPath('userData'), 'world-backups');
  }

  async function savesRootOf(payload) {
    const instance = await requireInstance(payload);
    const root = await getInstanceStore().folderFor(instance, 'saves');
    return { instance, root };
  }

  ipcMain.handle('worlds:list', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    try {
      return await worlds.listWorlds(root);
    } catch (error) {
      throw new Error(`读取世界列表失败：${error.message}`);
    }
  });

  ipcMain.handle('worlds:info', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    try {
      return await worlds.readWorld(root, String(payload.folder || ''));
    } catch (error) {
      throw new Error(`读取世界信息失败：${error.message}`);
    }
  });

  ipcMain.handle('worlds:save-info', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    try {
      return await worlds.saveWorld(root, String(payload.folder || ''), payload.patch || {});
    } catch (error) {
      throw new Error(`写入 level.dat 失败：${error.message}`);
    }
  });

  ipcMain.handle('worlds:delete', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    await worlds.deleteWorld(root, String(payload.folder || ''));
    return worlds.listWorlds(root);
  });

  ipcMain.handle('worlds:duplicate', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    const result = await worlds.duplicateWorld(root, String(payload.folder || ''));
    return { ...result, list: await worlds.listWorlds(root) };
  });

  ipcMain.handle('worlds:export', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    const folder = String(payload.folder || '');

    const picked = await dialog.showSaveDialog(win, {
      title: '导出世界',
      defaultPath: `${folder}.zip`,
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
    });
    if (picked.canceled || !picked.filePath) return null;

    try {
      return await worlds.exportWorld(root, folder, picked.filePath);
    } catch (error) {
      throw new Error(`导出世界失败：${error.message}`);
    }
  });

  ipcMain.handle('worlds:open-folder', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    const dir = worlds.worldDir(root, String(payload.folder || ''));
    return { path: await openFolderPath(dir) };
  });

  ipcMain.handle('worlds:backups', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    return worlds.listBackups(backupsRoot(), root);
  });

  ipcMain.handle('worlds:backup-create', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    const backup = await worlds.createBackup(backupsRoot(), root, String(payload.folder || ''));
    const list = await worlds.listBackups(backupsRoot(), root);
    return { backup, ...list };
  });

  ipcMain.handle('worlds:backup-restore', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    const result = await worlds.restoreBackup(backupsRoot(), root, String(payload.file || ''));
    return { ...result, list: await worlds.listWorlds(root) };
  });

  ipcMain.handle('worlds:backup-delete', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    await worlds.deleteBackup(backupsRoot(), String(payload.file || ''));
    return worlds.listBackups(backupsRoot(), root);
  });

  ipcMain.handle('worlds:open-backup-folder', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    const dir = worlds.backupDirOf(backupsRoot(), root);
    await fs.mkdir(dir, { recursive: true });
    return { path: await openFolderPath(dir) };
  });

  ipcMain.handle('worlds:datapacks', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    return worlds.listDatapacks(root, String(payload.folder || ''));
  });

  ipcMain.handle('worlds:import-datapack', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    const folder = String(payload.folder || '');

    const picked = await dialog.showOpenDialog(win, {
      title: '导入数据包',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '数据包 / 压缩包', extensions: ['zip', 'jar'] }]
    });
    if (picked.canceled || !picked.filePaths.length) return null;

    const imported = [];
    for (const file of picked.filePaths) {
      const result = await worlds.importDatapack(root, folder, file);
      imported.push(result.path);
    }
    return { imported, ...(await worlds.listDatapacks(root, folder)) };
  });

  ipcMain.handle('worlds:delete-datapack', async (event, payload = {}) => {
    assertAppWindow(event);
    const { root } = await savesRootOf(payload);
    await worlds.deleteDatapack(root, String(payload.folder || ''), String(payload.name || ''));
    return worlds.listDatapacks(root, String(payload.folder || ''));
  });

  // ---------------- 下载中心：Modrinth 内容（模组 / 资源包 / 光影） ----------------

  // 界面的内容类型 → instance-store 的内容目录 key
  const ADDON_KINDS = {
    mods: 'mods',
    resourcepack: 'resourcepacks',
    shader: 'shaderpacks'
  };

  function addonKindOf(payload) {
    const kind = String((payload && payload.kind) || 'mods');
    if (!ADDON_KINDS[kind]) throw new Error(`不支持的内容类型：${kind}`);
    return kind;
  }

  function loaderKeyForInstance(instance) {
    const label = String((instance && instance.modLoader) || '').toLowerCase();
    if (label === 'fabric') return 'fabric';
    if (label === 'quilt') return 'quilt';
    if (label === 'forge') return 'forge';
    if (label === 'neoforge') return 'neoforge';
    return '';
  }

  ipcMain.handle('downloads:addon-search', async (event, payload = {}) => {
    assertAppWindow(event);
    try {
      return await modrinth.searchProjects({
        kind: addonKindOf(payload),
        query: payload.query,
        gameVersion: payload.gameVersion,
        loader: payload.loader,
        sort: payload.sort,
        limit: payload.limit,
        offset: payload.offset
      });
    } catch (error) {
      console.error('[addons] search failed:', error);
      throw new Error(`搜索失败：${error.message}`);
    }
  });

  ipcMain.handle('downloads:addon-versions', async (event, payload = {}) => {
    assertAppWindow(event);
    addonKindOf(payload);
    try {
      return await modrinth.listVersions({
        projectId: String(payload.projectId || ''),
        gameVersion: payload.gameVersion,
        loader: payload.loader
      });
    } catch (error) {
      console.error('[addons] list versions failed:', error);
      throw new Error(`读取版本失败：${error.message}`);
    }
  });

  ipcMain.handle('downloads:install-addon', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const kind = addonKindOf(payload);
    const instance = await requireInstance(payload);

    const versionId = String(payload.versionId || '').trim();
    if (!versionId) throw new Error('缺少要安装的版本');

    const send = (progress) => {
      if (!win.isDestroyed()) {
        win.webContents.send('downloads:addon-progress', progress);
      }
    };

    try {
      const version = await modrinth.getVersion(versionId);
      const folder = await getInstanceStore().folderFor(instance, ADDON_KINDS[kind]);
      const result = await modrinth.downloadVersion({
        version,
        targetDir: folder,
        installDependencies: Boolean(payload.installDependencies) && kind === 'mods',
        gameVersion: instance.versionName || '',
        loader: loaderKeyForInstance(instance),
        onProgress: send
      });

      return {
        root: folder,
        installed: result.installed,
        failed: result.failed,
        instanceId: instance.id,
        instanceName: instance.displayName || instance.versionName || instance.id
      };
    } catch (error) {
      console.error('[addons] install failed:', error);
      if (!win.isDestroyed()) {
        win.webContents.send('downloads:addon-progress', { message: `安装失败：${error.message}` });
      }
      throw error;
    }
  });

  ipcMain.handle('downloads:save-addon', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    addonKindOf(payload);

    const versionId = String(payload.versionId || '').trim();
    if (!versionId) throw new Error('缺少要下载的版本');

    const picked = await dialog.showOpenDialog(win, {
      title: '下载到文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths.length) return null;

    const version = await modrinth.getVersion(versionId);
    const result = await modrinth.downloadVersion({
      version,
      targetDir: picked.filePaths[0],
      installDependencies: false,
      onProgress: (progress) => {
        if (!win.isDestroyed()) win.webContents.send('downloads:addon-progress', progress);
      }
    });

    return { folder: picked.filePaths[0], ...result };
  });

  // ---------------- 实例：重命名 / 复制 / 删除 / 打开目录 / 启动脚本 ----------------

  ipcMain.handle('instances:rename', async (event, payload = {}) => {
    assertAppWindow(event);
    const instanceId = String(payload.instanceId || '');
    const name = sanitizeDisplayName(payload.name);

    if (!name) throw new Error('名称不能为空');
    if (name.length > 48) throw new Error('名称不能超过 48 个字符');

    const { instance } = await findInstance(instanceId);
    if (!instance) throw new Error('实例不存在');

    const aliases = await readAliases();
    aliases[instance.path] = name;
    await writeAliases(aliases);

    return rescanInstances(instanceId);
  });

  ipcMain.handle('instances:duplicate', async (event, payload = {}) => {
    assertAppWindow(event);

    const { instance } = await findInstance(String(payload.instanceId || ''));
    if (!instance) throw new Error('实例不存在');

    const versionsDir = path.join(instance.gameDir, 'versions');
    const baseName = path.basename(instance.path);

    let target = '';
    let targetName = '';
    for (let index = 1; index <= 50; index += 1) {
      targetName = index === 1 ? `${baseName} - 副本` : `${baseName} - 副本 ${index}`;
      target = path.join(versionsDir, targetName);
      try {
        await fs.access(target);
      } catch {
        break;
      }
      target = '';
    }
    if (!target) throw new Error('副本数量太多，请先清理旧的副本');

    await fs.cp(instance.path, target, { recursive: true });

    const aliases = await readAliases();
    const sourceAlias = aliases[instance.path] || instance.displayName || baseName;
    const copyName = sanitizeDisplayName(payload.name);
    aliases[target] = copyName || `${sourceAlias} · 副本`;
    await writeAliases(aliases);

    const snapshot = await rescanInstances();
    const created = snapshot.instances.find(
      (item) => path.resolve(item.path).toLowerCase() === path.resolve(target).toLowerCase()
    );
    if (created) snapshot.selectedId = created.id;
    return snapshot;
  });

  ipcMain.handle('instances:remove', async (event, payload = {}) => {
    assertAppWindow(event);

    const { instance } = await findInstance(String(payload.instanceId || ''));
    if (!instance) throw new Error('实例不存在');

    const versionsDir = path.resolve(instance.gameDir, 'versions');
    if (path.resolve(path.dirname(instance.path)).toLowerCase() !== versionsDir.toLowerCase()) {
      throw new Error('只能删除游戏目录 versions 下的实例文件夹');
    }

    await fs.rm(instance.path, { recursive: true, force: true });

    const aliases = await readAliases();
    delete aliases[instance.path];
    await writeAliases(aliases);

    return rescanInstances();
  });

  ipcMain.handle('instances:open-folder', async (event, payload = {}) => {
    assertAppWindow(event);

    const target = String(payload.path || '');
    if (target) {
      // 渲染进程可以自己传路径（例如启动脚本目录），但只允许落在启动器数据目录
      // 或已登记的游戏目录之内，且不能是 UNC / 设备路径。
      return { path: await openFolderPath(await assertOpenablePath(target)) };
    }

    const { instance } = await findInstance(String(payload.instanceId || ''));
    if (!instance) throw new Error('实例不存在');
    return { path: await openFolderPath(instance.gameDir) };
  });

  /**
   * 生成启动脚本：命令行可能超过 cmd 的 8191 字符上限，
   * 所以主体写成 .ps1（参数数组，一行一个），再用 .bat 转调。
   *
   * .ps1 是固定模板，实例名 / 参数 / Java 路径都在同目录的 launch-data.json 里：
   * 数据永远不拼进脚本源码，实例名里有什么字符都不会变成代码。
   * 令牌也不落盘，模板运行时从启动器账号数据里读。
   */
  ipcMain.handle('instances:launch-script', async (event, payload = {}) => {
    assertAppWindow(event);

    const { instance } = await findInstance(String(payload.instanceId || ''));
    if (!instance) throw new Error('实例不存在');

    const store = getAccountStore();
    let account = await store.getSelected();
    if (!account) throw new Error('还没有选择账号，请先在「账户」页创建或登录');
    if (account.type === 'microsoft') {
      account = await accounts.ensureFreshToken(account);
    }

    const versionId = path.basename(instance.path);
    const settings = await effectiveSettings(instance.path);

    // 用占位符代替真实令牌：plan.args 里所有出现令牌的地方都会被替换掉。
    const scriptAccount = { ...account, accessToken: launchScript.TOKEN_PLACEHOLDER };

    const plan = await launcher.buildLaunchPlan({
      gameDir: instance.gameDir,
      instanceId: versionId,
      account: scriptAccount,
      settings,
      dataDir: app.getPath('userData'),
      resolveJava: (options) => resolveJavaRuntime({ ...options, javaPath: settings.javaPath })
    });

    const files = launchScript.buildLaunchScriptFiles({
      plan,
      displayName: instance.displayName || versionId,
      accountId: account.id,
      accountsFile: path.join(app.getPath('userData'), 'accounts.json')
    });

    const writeInto = async (dir) => {
      const target = path.join(dir, files.names.ps1);
      const batTarget = path.join(dir, files.names.bat);
      const dataTarget = path.join(dir, files.names.data);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(target, '\uFEFF' + files.ps1Text, 'utf8');
      await fs.writeFile(batTarget, files.batText, 'utf8');
      await fs.writeFile(dataTarget, files.dataText, 'utf8');
      return { ps1: target, bat: batTarget, data: dataTarget, dir };
    };

    let written;
    let fallback = false;

    try {
      written = await writeInto(instance.path);
    } catch (error) {
      // 实例目录可能只读或被安全软件拦住：退到启动器数据目录，别把整件事判失败。
      if (!['EPERM', 'EACCES', 'EROFS', 'EBUSY'].includes(error && error.code)) throw error;
      // 文件和文件名都是固定的，所以回退目录按实例分子目录，避免互相覆盖。
      const fallbackDir = path.join(
        app.getPath('userData'),
        'launch-scripts',
        launchScript.fileStem(versionId)
      );
      written = await writeInto(fallbackDir);
      fallback = true;
      console.warn('[launch-script] instance folder not writable, wrote to', fallbackDir);
    }

    return { ...written, fallback, needsToken: files.needsToken, warnings: plan.warnings };
  });

  // ---------------- 游戏目录管理 ----------------

  ipcMain.handle('gamedirs:list', async (event) => {
    assertAppWindow(event);
    return getGameDirStore().list();
  });

  ipcMain.handle('gamedirs:save', async (event, payload = {}) => {
    assertAppWindow(event);
    // UNC / 设备路径在 stat 阶段就会外发认证，这里直接拒掉。
    const dirPath = pathGuard.assertLocalPath(payload && payload.path, '游戏文件夹路径');
    return getGameDirStore().save({
      id: payload && payload.id ? String(payload.id) : '',
      dirPath,
      useRelativePath: Boolean(payload && payload.useRelativePath)
    });
  });

  ipcMain.handle('gamedirs:remove', async (event, id) => {
    assertAppWindow(event);
    return getGameDirStore().remove(String(id || ''));
  });

  ipcMain.handle('gamedirs:pick', async (event) => {
    const win = assertAppWindow(event);
    const result = await dialog.showOpenDialog(win, {
      title: '选择游戏文件夹',
      buttonLabel: '选择',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // ---------------- 实例级设置 / 图标 / 内容 ----------------

  /** 按 instanceId 拿到实例，找不到就抛错。 */
  async function requireInstance(payload) {
    const { instance } = await findInstance(String((payload && payload.instanceId) || ''));
    if (!instance) throw new Error('实例不存在');
    return instance;
  }

  ipcMain.handle('instances:settings', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    return {
      overrides: await getInstanceStore().getSettings(instance.path),
      global: await readSettings(),
      effective: await effectiveSettings(instance.path)
    };
  });

  ipcMain.handle('instances:save-settings', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    const patch = payload && payload.patch && typeof payload.patch === 'object' ? payload.patch : {};

    // 实例级 javaPath 同样会进入 spawn，必须过同一个授权校验。
    if (typeof patch.javaPath === 'string' && patch.javaPath.trim()) {
      const selected = await javaRuntime.assertJavaSelection(patch.javaPath.trim());
      patch.javaPath = selected.real;
    }

    const overrides = await getInstanceStore().saveSettings(instance.path, patch);
    return { overrides, effective: await effectiveSettings(instance.path) };
  });

  ipcMain.handle('instances:icon-get', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    return getInstanceStore().iconData(instance.path);
  });

  ipcMain.handle('instances:icon-set-builtin', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    const icon = await getInstanceStore().setBuiltinIcon(instance.path, payload.key);
    return { icon, iconKey: icon.key, iconDataUrl: '' };
  });

  ipcMain.handle('instances:icon-pick', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const instance = await requireInstance(payload);

    const result = await dialog.showOpenDialog(win, {
      title: '选择实例图标',
      buttonLabel: '使用这张图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;

    const saved = await getInstanceStore().setFileIcon(instance.path, result.filePaths[0]);
    return { icon: saved.icon, iconKey: '', iconDataUrl: saved.dataUrl };
  });

  ipcMain.handle('instances:icon-clear', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    await getInstanceStore().clearIcon(instance.path);
    return { icon: null, iconKey: '', iconDataUrl: '' };
  });

  ipcMain.handle('instances:content-list', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    const kind = String((payload && payload.kind) || 'mods');
    return getInstanceStore().listContent(instance, kind);
  });

  ipcMain.handle('instances:content-toggle', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    return getInstanceStore().setModEnabled(instance, String(payload.path || ''), Boolean(payload.enabled));
  });

  ipcMain.handle('instances:content-delete', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    await getInstanceStore().deleteContent({
      instance,
      kind: String(payload.kind || 'mods'),
      target: String(payload.path || '')
    });
    return getInstanceStore().listContent(instance, String(payload.kind || 'mods'));
  });

  /** 批量启用 / 禁用（模组），失败项会记在 failed 里，不整体回滚。 */
  ipcMain.handle('instances:content-set-many', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);

    const enabled = Boolean(payload && payload.enabled);
    const paths = Array.isArray(payload && payload.paths) ? payload.paths : [];
    const failed = [];

    for (const item of paths) {
      try {
        await getInstanceStore().setModEnabled(instance, String(item), enabled);
      } catch (error) {
        failed.push({ path: String(item), message: error.message });
      }
    }

    return { changed: paths.length - failed.length, failed };
  });

  /** 批量删除：每个路径都走一次越界校验。 */
  ipcMain.handle('instances:content-delete-many', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);

    const kind = String((payload && payload.kind) || 'mods');
    const paths = Array.isArray(payload && payload.paths) ? payload.paths : [];
    const failed = [];

    for (const item of paths) {
      try {
        await getInstanceStore().deleteContent({ instance, kind, target: String(item) });
      } catch (error) {
        failed.push({ path: String(item), message: error.message });
      }
    }

    const list = await getInstanceStore().listContent(instance, kind);
    return { ...list, changed: paths.length - failed.length, failed };
  });

  /** 在资源管理器里定位到某个文件（没有目标就打开目录）。 */
  ipcMain.handle('instances:content-reveal', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);

    const target = String((payload && payload.path) || '');
    const gameDir = path.resolve(instance.gameDir);

    if (target) {
      // 用 realpath 判定：游戏目录里的 junction 不能把它带到目录外。
      const resolved = await pathGuard.assertInsideReal(gameDir, target, '要定位的文件');
      return { path: await revealPath(resolved) };
    }

    const kind = String((payload && payload.kind) || 'mods');
    const folder = await getInstanceStore().folderFor(instance, kind);
    return { path: await openFolderPath(folder) };
  });

  ipcMain.handle('instances:content-import', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const instance = await requireInstance(payload);
    const kind = String((payload && payload.kind) || 'mods');

    const filters = kind === 'mods'
      ? [{ name: '模组', extensions: ['jar', 'zip', 'disabled'] }]
      : kind === 'resourcepacks'
        ? [{ name: '资源包', extensions: ['zip', 'jar'] }]
        : kind === 'schematics'
          ? [{ name: '原理图', extensions: ['schematic', 'schem', 'nbt', 'litematic'] }]
          : [];

    const result = await dialog.showOpenDialog(win, {
      title: '选择要导入的文件',
      buttonLabel: '导入',
      filters,
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;

    await getInstanceStore().importContent({
      instance,
      kind,
      sourcePaths: result.filePaths
    });

    return getInstanceStore().listContent(instance, kind);
  });

  /** 打开实例下的某个文件夹（内容管理页的「打开文件夹」）。 */
  ipcMain.handle('instances:content-folder', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    const folder = await getInstanceStore().folderFor(instance, String(payload.kind || 'mods'));
    return { path: await openFolderPath(folder) };
  });

  /**
   * 整进程重启：改了主进程（Node 侧）代码后，页面刷新不会重载它，
   * 容易出现「新界面 + 旧后端」。标题栏「刷新」按住 Shift 走这里。
   */
  ipcMain.handle('app:relaunch', async (event) => {
    assertAppWindow(event);
    setImmediate(() => {
      app.relaunch();
      app.exit(0);
    });
    return true;
  });

  ipcMain.handle('shell:open-logs', async (event) => {
    assertAppWindow(event);
    // 走和「打开文件夹」同一条路径：存在性 / 可读性预检 + explorer 直启 + 返回值检查
    await openFolderPath(app.getPath('logs'));
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
      // 用和实例列表同一套扫描（主目录 + 用户添加的游戏文件夹 + 已缓存的其他启动器），
      // 否则从「添加游戏文件夹」进来的实例会找不到。
      const snapshot = await rescanInstances();
      const instance =
        snapshot.instances.find((item) => item.id === instanceId) ||
        snapshot.instances.find((item) => item.id === snapshot.selectedId);

      if (!instance) throw new Error('没有可启动的实例，请先创建一个实例');

      const versionId = path.basename(instance.path);
      const gameDir = instance.gameDir || snapshot.gameDir;

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

      const settings = await effectiveSettings(instance.path);

      send({ phase: 'starting', instanceId, versionId, memoryMb: settings.memoryMb });

      const result = await launcher.launchInstance({
        gameDir,
        instanceId: versionId,
        account,
        settings,
        resolveJava: (options) => resolveJavaRuntime({ ...options, javaPath: settings.javaPath }),
        onEvent: (kind, data) => {
          if (kind === 'output') {
            send({ phase: 'output', stream: data.stream, text: data.text });
            return;
          }
          send({ phase: kind, ...data });
        }
      });

      await store.markUsed(account.id).catch(() => {});

      // 「测试游戏」：启动后把本次输出日志直接打开，方便看堆栈。
      // openPath 不会 reject，失败时 resolve 成错误字符串，所以要读返回值。
      if (payload && payload.test) {
        const logError = await shell.openPath(result.logFile);
        if (logError) console.warn('[launch] 打开本次日志失败：', logError, result.logFile);
      }

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

  /** 重新向微软 / 认证服务器要一次皮肤（换了皮肤后用）。 */
  ipcMain.handle('accounts:refresh-skin', async (event, id) => {
    assertAppWindow(event);
    const accountId = String(id || '');
    const store = getAccountStore();
    const account = await store.getById(accountId);
    const previousUrl = account && account.skinUrl ? account.skinUrl : '';

    await store.clearRemoteSkin(accountId);
    let skin = await readSkinData(accountId);

    // 刷新失败（令牌过期、离线、服务器拒绝）时退回原来的皮肤地址，
    // 至少还能用到本机缓存，而不是把头像清空。
    if ((!skin || !skin.dataUrl) && previousUrl) {
      await store
        .save({ id: accountId, skinUrl: previousUrl, skinModel: account.skinModel || 'classic' })
        .catch(() => {});
      const cached = await readSkinData(accountId);
      return {
        skin: cached,
        error: '无法从服务器取到新皮肤，仍显示本机缓存'
      };
    }

    return { skin };
  });

  // ---------------- 设置 ----------------

  ipcMain.handle('settings:get', async (event) => {
    assertAppWindow(event);
    const settings = await readSettings();
    let javaRuntimes = [];
    try {
      javaRuntimes = await javaRuntime.getJavaRuntimes(mcdl, { cacheFile: javaRuntimeCacheFile() });
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
   * 自定义 Java 的唯一登记入口。
   *
   * 走系统对话框：返回值由主进程拿到，渲染进程伪造不了一个"用户真的选过"的文件。
   * 这里会真的执行一次 `-version` 确认它是 JVM（假 Java 改名也过不了），
   * 成功后连同指纹记入授权表，后续启动只做指纹比对、不再执行。
   */
  ipcMain.handle('settings:pick-java', async (event) => {
    const win = assertAppWindow(event);
    const result = await dialog.showOpenDialog(win, {
      title: '选择 Java 可执行文件',
      buttonLabel: '使用这个 Java',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Java', extensions: ['exe'] }, { name: '全部文件', extensions: ['*'] }]
        : [{ name: '全部文件', extensions: ['*'] }]
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;

    const { info, record } = await javaRuntime.registerJava(result.filePaths[0]);
    return { path: record.real, info, identity: await javaRuntime.javaAuthorization(record.real) };
  });

  /** 启动时只读偏好，不触发 Java 扫描。 */
  ipcMain.handle('settings:preferences', async (event) => {
    assertAppWindow(event);
    return readSettings();
  });

  /** 关于页：版本、运行时与数据目录。 */
  ipcMain.handle('app:info', async (event) => {
    assertAppWindow(event);
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      userData: app.getPath('userData'),
      gameDir: mcdl.DEFAULT_GAME_DIR,
      repo: 'https://github.com/jkoyli/mcdl-launcher'
    };
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

  // 「写了不等于生效」：启动参数里的 --no-sandbox / --disable-web-security 会覆盖
  // webPreferences，所以这里把实际生效的值打出来，一眼能看出底线有没有被抹掉。
  try {
    const effective = mainWindow.webContents.getLastWebPreferences() || {};
    console.log(
      `[security] webPreferences: contextIsolation=${effective.contextIsolation} ` +
      `nodeIntegration=${effective.nodeIntegration} sandbox=${effective.sandbox}`
    );
    const unsafeSwitches = process.argv.filter((arg) =>
      /^--(no-sandbox|disable-web-security|disable-site-isolation-trials|allow-running-insecure-content)$/.test(arg)
    );
    if (unsafeSwitches.length > 0) {
      console.warn(`[security] 启动参数里有关闭安全边界的开关：${unsafeSwitches.join(' ')}`);
    }
    if (effective.nodeIntegration || !effective.contextIsolation) {
      console.warn('[security] 渲染进程没有跑在 contextIsolation + 无 nodeIntegration 的配置下');
    }
  } catch (error) {
    console.warn('[security] 无法读取生效的 webPreferences:', error.message);
  }

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

  // will-navigate 不覆盖子框架；将来一旦有内嵌页面，这里就是它唯一的门。
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (!/^file:\/\//i.test(String(event.url || ''))) {
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

    // 渲染层不需要任何网页权限（摄像头 / 通知 / 剪贴板读取 / 地理位置…），一律拒绝。
    // 不设的话走 Chromium 默认行为，等于给将来出现的内嵌页面留了口子。
    try {
      const ses = electronSession.defaultSession;
      ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
    } catch (error) {
      console.warn('[security] 无法设置权限处理器:', error.message);
    }

    registerIpcHandlers();
    createWindow();

    readSettings()
      .then((settings) => applySettingsSideEffects(settings))
      .catch((error) => console.warn('[settings] could not load on startup:', error.message));

    // 从设置里的指纹恢复 Java 授权（只比对指纹，不执行任何程序）。
    // 对不上就丢掉授权，让下次启动明确报"请重新选择 Java"。
    readJavaIdentity()
      .then((identity) => javaRuntime.restoreJavaAuthorization(identity))
      .then((record) => {
        if (!record) return;
        console.log(`[security] Java 授权已恢复：${record.real}（major=${record.major}）`);
      })
      .catch((error) => console.warn('[security] Java 授权恢复失败:', error.message));

    console.log('[main] BrowserWindow created');
    console.log(`[mcdl] jar: ${mcdl.MCDL_JAR}`);
    console.log(`[mcdl] default game dir: ${mcdl.DEFAULT_GAME_DIR}`);

    checkUserDataWritable().catch(() => {});

    // 低完整性级别不会阻止启动，但会让「打开文件夹 / 定位文件」全部静默失效，
    // 所以启动时先探测一次，把原因直接写在终端里。
    isLowIntegrity().then((low) => {
      if (!low) return;
      console.warn(
        '[env] 进程运行在低完整性级别（Low IL）：打开文件夹 / 定位文件会被 Windows 拒绝。' +
          '请从资源管理器直接双击 启动.bat 重启。'
      );
    });

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
