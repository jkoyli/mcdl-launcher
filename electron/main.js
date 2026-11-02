'use strict';

const {
  app, BrowserWindow, ipcMain, shell, Menu, dialog, session: electronSession,
  protocol, nativeImage, clipboard
} = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
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
const modpackExport = require('./modpack-export');
const javaInstall = require('./java-install');
const nbtEditor = require('./nbt-editor');
const appLog = require('./app-log');
const { writeFileAtomic, flushWrites } = require('./atomic-write');

const IS_DEV = process.argv.includes('--dev');

console.log(`[main] booting Electron app (dev=${IS_DEV})`);

/**
 * 自上传壁纸用的特权协议。
 *
 * 必须在 app ready 之前登记：Chromium 对未登记的自定义 scheme 会当成 opaque origin，
 * `<img src>` 也许能显示，但 <video> 的 Range 请求与 CSP 的 `mcdl-media:` 匹配都不稳定。
 * `standard: true` 是"这个 scheme 有 origin"的关键，`stream: true` 让响应可以是流
 * （视频不能等整段读完再播）。
 *
 * 渲染进程是 loadFile() 起的（origin = file://），所以本地 mp4 既不能用 <video src="file://">
 * 播放（会被 CSP / 本地文件策略拦），也不能塞 data: URL（base64 会把内存打爆）。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mcdl-media',
    privileges: { standard: true, stream: true, bypassCSP: false, supportFetchAPI: false }
  }
]);

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

// 启动器日志落盘：崩溃窗口 / 日志窗口的「打开日志文件夹」都指向这里。
// 必须在其它模块开始打日志之前初始化，所以紧跟在 userData 选定之后。
appLog.init(USER_DATA_DIR);

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

/**
 * 「启动后多久内退出算启动失败」。
 * 15 秒内非 0 退出且没有崩溃报告，基本不是玩着玩着崩了，而是根本没起来
 * （Java 版本不对、classpath 有问题、参数被整合包改坏）。两者给用户的下一步动作不同。
 */
const EARLY_FAILURE_MS = 15000;

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
  notifyLauncherCrash(error, 'main-uncaught');
});

process.on('unhandledRejection', (error) => {
  console.error('[main] unhandledRejection:', error);
  notifyLauncherCrash(error, 'main-rejection');
});

/**
 * 启动器崩溃：把错误推给渲染进程，由它弹「崩溃窗口」。
 * 渲染进程已经死了的时候这个事件没人收，日志文件仍然留在 appLog 里。
 */
let lastCrashNoticeAt = 0;

function notifyLauncherCrash(error, source) {
  const now = Date.now();
  // 同一秒内的连环异常只弹一次，避免崩溃窗口套崩溃窗口。
  if (now - lastCrashNoticeAt < 2500) return;
  lastCrashNoticeAt = now;

  const message = error && (error.stack || error.message) ? String(error.stack || error.message) : String(error || '未知错误');
  appLog.append('ERROR', `[crash][${source}] ${message}`);

  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('launcher:crash', {
      source: String(source || 'main'),
      message,
      at: now,
      logFile: appLog.file(),
      logDir: appLog.dir()
    });
  } catch (sendError) {
    console.warn('[crash] could not notify renderer:', sendError.message);
  }
}

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

// ---------------- 渲染进程崩溃恢复（分层） ----------------
//
// Electron 的 render-process-gone 默认没人监听：渲染进程一死，窗口就静默留个白板，
// 用户只能强杀进程。启动器场景里这不可接受，所以要分三层：
//   L1 单次崩溃 → reload()（多数 OOM 只要重来一次就好）；
//   L2 短时间内连续 3 次 → 判定崩溃循环，切到零依赖静态恢复页
//      （不加载主包：主包本身可能就是崩溃原因）；
//   L3 恢复页给出「重新加载 / 重置工作区 / 导出诊断」三个出口。
const RENDERER_CRASH_WINDOW_MS = 60 * 1000;
const RENDERER_CRASH_LOOP = 3;

const rendererCrashes = [];
let recoveryPageActive = false;

function recoveryPageFile() {
  return path.join(__dirname, 'renderer', 'recovery.html');
}

function pruneRendererCrashes() {
  const cutoff = Date.now() - RENDERER_CRASH_WINDOW_MS;
  while (rendererCrashes.length > 0 && rendererCrashes[0] < cutoff) rendererCrashes.shift();
}

/**
 * 切到静态恢复页。reason 会作为 query 传给页面，页面把它显示出来，
 * 用户反馈问题时不用再猜「为什么会看到这个界面」。
 */
function loadRecoveryPage(reason, details = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  recoveryPageActive = true;

  appLog.append('ERROR', `[recovery] showing recovery page: reason=${reason}`);

  const query = {
    reason: String(reason || 'crashed'),
    at: String(Date.now()),
    crashes: String(rendererCrashes.length),
    exitCode: details && details.exitCode !== undefined ? String(details.exitCode) : '',
    errorCode: details && details.errorCode !== undefined ? String(details.errorCode) : '',
    errorDescription: details && details.errorDescription ? String(details.errorDescription) : ''
  };

  mainWindow.loadFile(recoveryPageFile(), { query }).catch((error) => {
    // 恢复页都打不开就只能留日志了，但至少别再往里套一层崩溃处理。
    console.error('[recovery] failed to load recovery page:', error.message);
  });
  return true;
}

/** 回到主界面（恢复页的「重新加载」/ 崩溃后自动 reload 都走这里）。 */
function loadMainPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  recoveryPageActive = false;
  rendererCrashes.length = 0;
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
    .catch((error) => {
      console.error('[main] loadFile failed:', error.message);
      loadRecoveryPage('load-failed', { errorDescription: error.message });
    });
  return true;
}

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
  // 皮肤缓存半截写入 = 一张坏 PNG，渲染层拿到 base64 也画不出来；原子写避免留下中间态。
  await writeFileAtomic(file, buffer);
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
  javaPath: '',
  // 启动前完整性闸门的哈希强度：null = 只哈希小文件（默认），true = 全部依赖库都算，false = 只查存在与非空。
  verifyFiles: null
};

// ---------------- 自上传壁纸：数据契约与文件边界 ----------------

/**
 * 壁纸只有两种来源，都在本机：
 *   图片 → 复制进 <userData>/backgrounds/，settings 里只存裸文件名；
 *   视频 → 只记绝对路径（不复制，几百 MB 的视频复制一份太贵），协议只服务"当前那一个"。
 *
 * 明确不做，别以后再问：
 *   ✗ 网络壁纸 / URL 来源（清单里的 launcher.background.network.cache 因此标 N/A）
 *   ✗ 主题包联动（背景独立于主题；主题包管理是另一层）
 *   ✗ 外圈 chrome（标题栏 / 导航 / 右栏）的额外模糊
 *   ✗ 窗口透明 / 标题栏透明（属另外两项）
 */
const WALL_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const WALL_VIDEO_EXTS = new Set(['.mp4', '.webm']);
const WALL_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

const WALL_IMAGE_MAX_EDGE = 8192;                       // 再大就是显存杀手（8K 贴图 ~130 MB）
const WALL_IMAGE_WARN_BYTES = 50 * 1024 * 1024;         // 只提示，不阻断
const WALL_VIDEO_WARN_BYTES = 500 * 1024 * 1024;
const WALL_THUMB_WIDTH = 160;
const WALL_NAME_MAX = 4096;

function wallpaperRoot() {
  return path.join(app.getPath('userData'), 'backgrounds');
}

function wallpaperThumbRoot() {
  return path.join(wallpaperRoot(), '.thumbs');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * wallFile 的取值随 wallMedia 变，校验也只做类型 / 形状（不碰文件系统）：
 *   图片 = backgrounds 内的裸文件名（带分隔符就等于"读 backgrounds 外的任意文件"）；
 *   视频 = 本机绝对路径，词法上必须过 assertLocalPath（拒 UNC / 设备路径）。
 * 运行期文件是否还在，由渲染层的加载失败回落处理（L5）。
 */
function normalizeWallFile(raw, media) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > WALL_NAME_MAX || value.includes('\0')) return '';

  if (media === 'video') {
    try {
      const resolved = pathGuard.assertLocalPath(value, '壁纸视频');
      return WALL_VIDEO_EXTS.has(path.extname(resolved).toLowerCase()) ? resolved : '';
    } catch {
      return '';
    }
  }

  if (!WALL_IMAGE_EXTS.has(path.extname(value).toLowerCase())) return '';
  return path.basename(value) === value ? value : '';
}

function clampWallNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const WALL_MODES = new Set(['default', 'custom']);
const WALL_MEDIA_KINDS = new Set(['image', 'video']);
const WALL_POLICIES = new Set(['single', 'random', 'startup']);
const WALL_INNER_FITS = new Set(['contain', 'cover']);

const DEFAULT_EXTRA_SETTINGS = {
  gameIsolation: 'auto',       // auto | isolated | global
  disableAprilFools: false,
  language: 'zh-CN',
  versionListSource: 'auto',   // auto | official | bmclapi
  downloadSource: 'auto',
  addonSource: 'modrinth',     // modrinth（curseforge 需要 API Key）
  disableAnimations: false,
  // 壁纸（L0 数据契约）：默认样式与改动前逐像素一致，全部默认值都不启用任何新图层。
  wallMode: 'default',         // default | custom
  wallMedia: 'image',          // image | video
  wallFile: '',                // 图片 = backgrounds 内文件名；视频 = 绝对路径
  wallPolicy: 'single',        // single | random | startup
  wallBlur: 18,                // 0-40
  wallDim: 30,                 // 0-70
  wallInnerFit: 'contain',     // contain | cover
  wallPip: true,               // 画中画：true = 内外双图；false = 内外同一张 cover
  presets: []                  // 游戏设置预设（名称 + 内存 / 窗口 / JVM / 隔离策略）
};


const ISOLATION_MODES = new Set(['auto', 'isolated', 'global']);
const ADDON_SOURCES = new Set(['modrinth']);

/**
 * 游戏设置预设：只保留能被 settings 直接使用的字段，名字与 id 都做长度 / 字符限制。
 * 渲染层提交什么形状都先过这一层，坏数据不落盘。
 */
function normalizePresets(raw) {
  if (!Array.isArray(raw)) return [];
  const result = [];
  const seen = new Set();

  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;

    const name = String(item.name || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40);
    if (!name) continue;

    let id = String(item.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!id) id = 'preset-' + (result.length + 1) + '-' + Math.random().toString(36).slice(2, 6);
    if (seen.has(id)) continue;
    seen.add(id);

    const entry = { id, name };

    const memory = Number(item.memoryMb);
    if (Number.isFinite(memory) && memory >= 512) entry.memoryMb = Math.min(32768, Math.round(memory));

    const width = Number(item.width);
    if (Number.isFinite(width) && width >= 320) entry.width = Math.min(7680, Math.round(width));

    const height = Number(item.height);
    if (Number.isFinite(height) && height >= 320) entry.height = Math.min(7680, Math.round(height));

    if (typeof item.jvmArgs === 'string' && item.jvmArgs.trim()) {
      entry.jvmArgs = item.jvmArgs.trim().slice(0, 2000);
    }

    const isolation = String(item.gameIsolation || '').trim();
    if (ISOLATION_MODES.has(isolation)) entry.gameIsolation = isolation;

    result.push(entry);
  }

  return result;
}

function normalizeExtraSettings(raw) {
  const source = (value, fallback) => {
    const key = String(value || '').trim().toLowerCase();
    return ['auto', 'official', 'bmclapi'].includes(key) ? key : fallback;
  };
  const isolation = String(raw.gameIsolation || '').trim();
  const addon = String(raw.addonSource || '').trim().toLowerCase();

  // 壁纸：枚举走白名单、数值 clamp、wallFile 按 media 校验形状。
  // 任何一个不合法都回落到默认值，绝不把非法值写盘。
  const wallMedia = WALL_MEDIA_KINDS.has(String(raw.wallMedia || '').trim())
    ? String(raw.wallMedia).trim()
    : 'image';
  const wallPipRaw = raw.wallPip === undefined ? true : raw.wallPip;

  return {
    gameIsolation: ISOLATION_MODES.has(isolation) ? isolation : 'auto',
    disableAprilFools: Boolean(raw.disableAprilFools),
    language: 'zh-CN',
    versionListSource: source(raw.versionListSource, 'auto'),
    downloadSource: source(raw.downloadSource, 'auto'),
    addonSource: ADDON_SOURCES.has(addon) ? addon : 'modrinth',
    disableAnimations: Boolean(raw.disableAnimations),
    wallMode: WALL_MODES.has(String(raw.wallMode || '').trim())
      ? String(raw.wallMode).trim()
      : 'default',
    wallMedia,
    wallFile: normalizeWallFile(raw.wallFile, wallMedia),
    wallPolicy: WALL_POLICIES.has(String(raw.wallPolicy || '').trim())
      ? String(raw.wallPolicy).trim()
      : 'single',
    wallBlur: clampWallNumber(raw.wallBlur, 0, 40, 18),
    wallDim: clampWallNumber(raw.wallDim, 0, 70, 30),
    wallInnerFit: WALL_INNER_FITS.has(String(raw.wallInnerFit || '').trim())
      ? String(raw.wallInnerFit).trim()
      : 'contain',
    wallPip: wallPipRaw === undefined || wallPipRaw === null ? true : Boolean(wallPipRaw),
    presets: normalizePresets(raw.presets)
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
    verifyFiles: normalized.verifyFiles,
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

/**
 * @param {object} patch
 * @param {{trustWallFile?: boolean}} [options]
 *   trustWallFile 只给 wallpaper:pick 用：视频壁纸存的是绝对路径，而协议会照着
 *   settings.wallFile 去读文件，所以渲染进程不能自己改它（否则等于一条"按扩展名
 *   读任意本地文件"的通道）。图片壁纸是 backgrounds 内的裸文件名，随时可改。
 */
async function writeSettings(patch, options = {}) {
  const current = await readSettings();
  const merged = launcher.normalizeSettings({ ...current, ...patch });
  const next = {
    memoryMb: merged.memoryMb,
    width: merged.width,
    height: merged.height,
    jvmArgs: merged.jvmArgs,
    javaPath: merged.javaPath,
    verifyFiles: merged.verifyFiles,
    ...normalizeExtraSettings({ ...current, ...patch })
  };

  const requestedWallFile =
    patch && typeof patch.wallFile === 'string' ? patch.wallFile.trim() : '';
  if (!options.trustWallFile && requestedWallFile && requestedWallFile !== current.wallFile) {
    const isManagedName = normalizeWallFile(requestedWallFile, 'image') === requestedWallFile;
    if (!isManagedName) {
      throw new Error('壁纸文件只能通过「上传图片 / 上传视频」选择');
    }
  }

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
    await writeFileAtomic(file, JSON.stringify({
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
      // 以前这里只打一行 warn 就照常启动，用户拿到的是 UnsupportedClassVersionError
      // → 秒退 → 「游戏闪退」。Java 版本是启动参数的一部分，不对就该在 spawn 之前中止。
      throw new Error(
        `这个版本需要 Java ${requiredMajor}，但当前选择的是 Java ${info.major}。\n` +
        '请到「设置 → Java」改成对应版本（或清空手动选择改用自动探测），再启动游戏。'
      );
    }
    return info;
  }

  const runtimes = await javaRuntime.getJavaRuntimes(mcdl, { cacheFile: javaRuntimeCacheFile() });
  const picked = javaRuntime.pickJava(runtimes, requiredMajor);

  // pickJava 在没有「够新」的运行时时会退而返回当前最高的那个（避免启动器完全不可用），
  // 但对「启动游戏」来说低版本 Java 必然失败，所以这里要显式拒绝，而不是带病 spawn。
  if (picked && requiredMajor && Number(picked.major) < Number(requiredMajor)) {
    throw new Error(
      `没有找到 Java ${requiredMajor}，本机最高的可用运行时是 Java ${picked.major}。\n` +
      `请先到「设置 → Java」下载 / 选择 Java ${requiredMajor}，再启动这个版本。`
    );
  }

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
 * 实例「游戏真正使用的游戏目录」：版本隔离实例是 versions/<id>，
 * 全局实例就是 .minecraft。启动、日志、崩溃报告都必须用这个目录，
 * 否则隔离实例会去读 .minecraft/mods（空的）→ 启动后一个 mod 都没有。
 */
async function instanceGameDirOf(instance) {
  if (!instance) return '';
  try {
    return await getInstanceStore().resolveGameDir(instance);
  } catch (error) {
    console.warn('[instance] resolve game dir failed:', error.message);
    return instance.gameDir ? path.resolve(instance.gameDir) : '';
  }
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
    javaPath: overrides.javaPath || globalSettings.javaPath || '',
    // 启动前是否哈希全部依赖库。true / false / null(=只哈希小文件)。
    verifyFiles: typeof merged.verifyFiles === 'boolean' ? merged.verifyFiles : null
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

/**
 * 渲染层指定的安装落点：必须是「启动器自己的目录」或已登记的某个游戏目录。
 * 只用于「更新整合包」与下载中心的可选 gameDir，避免变成"往任意路径写文件"的通道。
 */
async function assertGameDirAllowed(raw) {
  const target = pathGuard.assertLocalPath(raw, '游戏目录');
  const managed = await managedGameDirs();
  const roots = [managed.primary, ...managed.dirs];
  return pathGuard.assertInsideAnyRoots(roots, target, '游戏目录', { allowEqual: true });
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
  // 别名表写坏 = 整个实例列表的名字全丢，必须原子写。
  await writeFileAtomic(file, JSON.stringify(aliases, null, 2), 'utf8');
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
  await writeFileAtomic(file, JSON.stringify({
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
 * 扫描缓存的完整状态：目录 + 上次写入时间。
 * 没有缓存文件（或文件损坏）时返回 { dirs: [], updatedAt: null }。
 */
async function readScanCacheState() {
  const dirs = await readScanCache();
  let updatedAt = null;
  try {
    const parsed = JSON.parse(await fs.readFile(scanCacheFile(), 'utf8'));
    if (parsed && !Array.isArray(parsed) && typeof parsed.updatedAt === 'string') {
      updatedAt = parsed.updatedAt;
    }
  } catch {
    updatedAt = null;
  }
  return { dirs, updatedAt };
}

/**
 * 清空扫描缓存（删文件；删不掉就写空数组，保证 readScanCache() 仍返回 []）。
 * 返回 { removed }：清掉了几条缓存目录。
 */
async function clearScanCache() {
  const before = await readScanCache();
  try {
    await fs.rm(scanCacheFile(), { force: true });
  } catch (error) {
    console.warn('[instances] could not delete scan cache file, truncating instead:', error);
    await writeScanCache([]).catch((writeError) => {
      console.warn('[instances] could not truncate scan cache:', writeError);
    });
  }
  return { removed: before.length };
}

/**
 * 只从扫描缓存里剔除一个目录（保留其余条目）。
 * 比较口径与 uniqueDirs 一致：path.resolve + 小写。
 */
async function forgetScanCacheDir(dirPath) {
  const raw = String(dirPath || '').trim();
  const before = await readScanCache();
  if (!raw) return { removed: 0, remaining: before.length };

  const key = path.resolve(raw).toLowerCase();
  const rest = before.filter((dir) => path.resolve(dir).toLowerCase() !== key);
  const removed = before.length - rest.length;

  if (removed > 0) {
    try {
      await writeScanCache(rest);
    } catch (error) {
      // 写失败不该让「删除游戏目录」这种主操作失败，只记日志。
      console.warn('[instances] could not persist scan cache after forget:', error);
    }
  }

  return { removed, remaining: rest.length };
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

function sendInstallOutput(win, bufferState, channel = 'instances:install-progress') {
  return (text) => {
    bufferState.value += String(text);
    const parts = bufferState.value.split(/\r\n|\n|\r/);
    bufferState.value = parts.pop() || '';

    for (const part of parts) {
      const message = part.trim();
      if (!message) continue;
      if (!win.isDestroyed()) {
        win.webContents.send(channel, { message });
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

/** 只留文件名可用的字符，给「另存为」的默认名用（真正的落点由系统对话框决定）。 */
function safeFileName(value) {
  return String(value == null ? '' : value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ---------------- 自上传壁纸：文件 / 协议 ----------------

async function ensureWallpaperDirs() {
  await fs.mkdir(wallpaperThumbRoot(), { recursive: true });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 文件名会进 URL 与资源管理器：只留字母 / 数字 / 下划线 / 连字符。 */
function sanitizeWallBaseName(raw) {
  const base = path.basename(String(raw || '')).replace(/\.[^.]+$/, '');
  const cleaned = base
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return cleaned || 'wallpaper';
}

function wallpaperFileName(hash, originalName, ext) {
  return `${String(hash).slice(0, 12)}-${sanitizeWallBaseName(originalName)}${ext}`;
}

function wallpaperThumbName(name) {
  return `${name}.png`;
}

function wallpaperLabel(name) {
  const stripped = path.basename(name).replace(/^[0-9a-f]{12}-/, '');
  return stripped || path.basename(name);
}

function wallpaperMediaUrl(kind, name) {
  if (kind === 'video') {
    // 绝对路径里有盘符、反斜杠、中文：base64url 之后只剩 [A-Za-z0-9_-]，
    // 不会和 URL 的路径规范化（.. / %5C / 大小写）打架。
    return `mcdl-media://ext/${Buffer.from(name, 'utf8').toString('base64url')}`;
  }
  return `mcdl-media://bg/${encodeURIComponent(name)}`;
}

function sameLocalPath(a, b) {
  const left = path.resolve(String(a || ''));
  const right = path.resolve(String(b || ''));
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * 只认扩展名不够：改名的 exe / 网页被当背景加载时，至少会表现为"选了但不显示"。
 * 这里按文件头核对真实容器格式（和皮肤 PNG 校验同一套思路）。
 */
async function wallpaperSignature(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let head;
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      head = Buffer.alloc(16);
      await handle.read(head, 0, 16, 0);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }

  const ascii = head.toString('latin1');
  if (ext === '.png') return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if (ext === '.jpg' || ext === '.jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (ext === '.gif') return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
  if (ext === '.webp') return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
  if (ext === '.mp4') return ascii.slice(4, 8) === 'ftyp';
  if (ext === '.webm') return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  return false;
}

/**
 * 生成缩略图。
 * 列表里如果直接拿原图当 64px 缩略图，Chromium 会按原尺寸解码 —— 一张 8K 就 ~130 MB，
 * 几张就能把渲染进程顶爆。所以落盘一份 160px 的 png，顺手拿到真实尺寸做超大图提示。
 */
async function makeWallpaperThumb(filePath, name) {
  try {
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return null;
    const size = image.getSize();
    const thumb = image.resize({ width: WALL_THUMB_WIDTH, quality: 'good' });
    await ensureWallpaperDirs();
    await writeFileAtomic(path.join(wallpaperThumbRoot(), wallpaperThumbName(name)), thumb.toPNG());
    return { width: size.width, height: size.height };
  } catch (error) {
    console.warn('[wallpaper] 缩略图生成失败:', error.message);
    return null;
  }
}

async function importWallpaperImage(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!WALL_IMAGE_EXTS.has(ext)) {
    throw new Error('只支持 png / jpg / jpeg / webp / gif 图片');
  }

  let stat;
  try {
    stat = await fs.stat(sourcePath);
  } catch {
    throw new Error('找不到这个文件');
  }
  if (!stat.isFile()) throw new Error('请选择一个文件');

  if (!(await wallpaperSignature(sourcePath))) {
    throw new Error('这个文件的内容不是有效图片（扩展名被改过？）');
  }

  const hash = await hashFile(sourcePath);
  const name = wallpaperFileName(hash, path.basename(sourcePath), ext);
  const target = path.join(wallpaperRoot(), name);

  let exists = null;
  try {
    exists = await fs.stat(target);
  } catch {
    exists = null;
  }

  if (!exists) {
    await ensureWallpaperDirs();
    // 用户直接挑 backgrounds 里已有的那张：源和目标是同一个文件，不能再拷一次。
    if (!sameLocalPath(sourcePath, target)) {
      await fs.copyFile(sourcePath, target);
    }
  }

  // 同一张图重复上传时走哈希命中，只在缩略图缺失时补一次。
  let thumbInfo = null;
  try {
    await fs.stat(path.join(wallpaperThumbRoot(), wallpaperThumbName(name)));
  } catch {
    thumbInfo = await makeWallpaperThumb(target, name);
  }
  if (!thumbInfo) thumbInfo = { width: 0, height: 0 };

  return { name, label: wallpaperLabel(name), size: stat.size, ...thumbInfo };
}

async function inspectWallpaperVideo(sourcePath) {
  const target = pathGuard.assertLocalPath(sourcePath, '壁纸视频');
  const ext = path.extname(target).toLowerCase();
  if (!WALL_VIDEO_EXTS.has(ext)) throw new Error('只支持 mp4 / webm 视频');

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    throw new Error('找不到这个文件');
  }
  if (!stat.isFile()) throw new Error('请选择一个文件');

  if (!(await wallpaperSignature(target))) {
    throw new Error('这个文件的内容不是有效视频（扩展名被改过？）');
  }

  let real = target;
  try {
    real = await fs.realpath(target);
  } catch {
    real = target;
  }

  return { path: real, size: stat.size };
}

async function listWallpapers(settings) {
  const root = wallpaperRoot();
  const items = [];
  let entries = [];

  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.')) continue;
    if (!WALL_IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;

    let stat = null;
    try {
      stat = await fs.stat(path.join(root, entry.name));
    } catch {
      continue;
    }

    let thumb = '';
    try {
      await fs.stat(path.join(wallpaperThumbRoot(), wallpaperThumbName(entry.name)));
      thumb = `mcdl-media://thumb/${encodeURIComponent(wallpaperThumbName(entry.name))}`;
    } catch {
      // 老数据（或 nativeImage 解不了的 webp/gif）：退回原图，至少能显示
      thumb = wallpaperMediaUrl('image', entry.name);
    }

    items.push({
      name: entry.name,
      label: wallpaperLabel(entry.name),
      kind: 'image',
      external: false,
      size: stat.size,
      mtime: stat.mtimeMs,
      url: wallpaperMediaUrl('image', entry.name),
      thumb,
      missing: false
    });
  }

  items.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));

  // 引用的图片被手动删掉（用户直接动 backgrounds 目录）时也算"丢失"。
  let missing = false;
  if (settings.wallFile && settings.wallMedia === 'image') {
    const known = items.some((item) => item.name === settings.wallFile);
    if (!known) missing = true;
  }

  // 视频只在"当前引用"里存在：它没有被复制进来，列表里也就只有这一条。
  if (settings.wallMedia === 'video' && settings.wallFile) {
    let stat = null;
    try {
      stat = await fs.stat(settings.wallFile);
    } catch {
      stat = null;
    }
    const exists = Boolean(stat && stat.isFile());
    if (!exists) missing = true;

    items.push({
      name: settings.wallFile,
      label: path.basename(settings.wallFile),
      kind: 'video',
      external: true,
      size: exists ? stat.size : 0,
      mtime: exists ? stat.mtimeMs : 0,
      url: exists ? wallpaperMediaUrl('video', settings.wallFile) : '',
      thumb: '',
      missing: !exists
    });
  }

  for (const item of items) {
    item.active = item.kind === 'video'
      ? sameLocalPath(item.name, settings.wallFile)
      : item.name === settings.wallFile;
  }

  return { root, items, missing };
}

function parseByteRange(header, size) {
  const value = String(header || '').trim();
  if (!value) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return { invalid: true };
  if (match[1] === '' && match[2] === '') return { invalid: true };

  let start;
  let end;
  if (match[1] === '') {
    // `bytes=-500`：最后 500 字节
    const length = Number(match[2]);
    if (!Number.isFinite(length) || length <= 0) return { invalid: true };
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

/**
 * 返回可被 <video> 拖动的响应：Range → 206 + Content-Range。
 * 用 fs.createReadStream 而不是 readFile：几百 MB 的视频不能整段进内存。
 */
async function streamWallpaperMedia(request, filePath, mime, cacheMode) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  if (!stat.isFile()) return new Response('Not Found', { status: 404 });

  const headers = new Headers({
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheMode === 'immutable'
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
  });

  const range = parseByteRange(request.headers.get('range'), stat.size);
  if (range && range.invalid) {
    headers.set('Content-Range', `bytes */${stat.size}`);
    headers.set('Content-Length', '0');
    return new Response(null, { status: 416, headers });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const length = stat.size === 0 ? 0 : end - start + 1;

  headers.set('Content-Length', String(length));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);

  if (request.method === 'HEAD' || length === 0) {
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  const stream = fsSync.createReadStream(filePath, { start, end });
  // 客户端取消（拖进度条 / 关闭页面）时流会被提前销毁：错误要自己接住，
  // 否则会冒泡成 uncaughtException。
  stream.on('error', (error) => {
    if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.warn('[wallpaper] 读取中断:', error.message);
    }
  });
  return new Response(Readable.toWeb(stream), {
    status: range ? 206 : 200,
    headers
  });
}

async function serveWallpaperMedia(request) {
  const url = new URL(request.url);
  const host = String(url.hostname || '').toLowerCase();
  const raw = url.pathname.replace(/^\/+/, '');
  let segment;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    throw new Error('壁纸 URL 编码非法');
  }

  if (host === 'bg' || host === 'thumb') {
    const isThumb = host === 'thumb';
    if (!segment || path.basename(segment) !== segment || segment.includes('\0')) {
      throw new Error('壁纸名称非法');
    }

    const root = isThumb ? wallpaperThumbRoot() : wallpaperRoot();
    const checkName = isThumb ? segment.replace(/\.png$/i, '') : segment;
    const ext = path.extname(checkName).toLowerCase();
    if (!WALL_IMAGE_EXTS.has(ext)) throw new Error('壁纸扩展名不在白名单');

    const target = path.join(root, segment);
    const real = await pathGuard.assertInsideReal(root, target, '壁纸文件');
    return streamWallpaperMedia(
      request,
      real,
      WALL_MIME[path.extname(real).toLowerCase()] || 'application/octet-stream',
      'immutable'
    );
  }

  if (host === 'ext') {
    let target;
    try {
      target = Buffer.from(segment, 'base64url').toString('utf8');
    } catch {
      throw new Error('视频路径编码非法');
    }

    const resolved = pathGuard.assertLocalPath(target, '壁纸视频');
    const ext = path.extname(resolved).toLowerCase();
    if (!WALL_VIDEO_EXTS.has(ext)) throw new Error('视频扩展名不在白名单');

    // 只服务"当前设置里那一支视频"：否则这条通道就是"按扩展名读任意本地文件"。
    const settings = await readSettings();
    if (settings.wallMedia !== 'video' || !settings.wallFile) {
      throw new Error('当前没有启用视频壁纸');
    }
    if (!sameLocalPath(resolved, settings.wallFile)) {
      throw new Error('不是当前壁纸视频');
    }

    const real = await fs.realpath(resolved);
    return streamWallpaperMedia(request, real, WALL_MIME[ext] || 'video/mp4', 'no-cache');
  }

  throw new Error(`未知的壁纸 host：${host}`);
}

// ---------------- 内容图标代理（mcdl-media://addon-icon/…） ----------------
//
// 下载中心的模组 / 资源包 / 光影卡片要显示项目自己上传的图标，但页面 CSP 不放行
// http(s)（`img-src 'self' data: mcdl-media:`），渲染层也没有联网能力。所以图标仍由
// 主进程抓取，再经这个已有特权协议交给 <img>：换 URL 不改 CSP，也不给页面直连外网的口子。
//
// 只放行 Modrinth 的图标 CDN（modrinth.fetchProjectIcon 会再校验一次），并按 URL 做
// 内存缓存——翻页、切页签、重新搜索都不重复下载同一张图。

const ADDON_ICON_HOST = 'addon-icon';
const ADDON_ICON_CACHE_MAX = 240;
const addonIconCache = new Map();

async function loadAddonIcon(iconUrl) {
  const cached = addonIconCache.get(iconUrl);
  if (cached) {
    // 命中就移到队尾：Map 的插入顺序当 LRU 用，淘汰最久没碰过的那张。
    addonIconCache.delete(iconUrl);
    addonIconCache.set(iconUrl, cached);
    return cached;
  }

  const icon = await modrinth.fetchProjectIcon(iconUrl);
  addonIconCache.set(iconUrl, icon);
  while (addonIconCache.size > ADDON_ICON_CACHE_MAX) {
    addonIconCache.delete(addonIconCache.keys().next().value);
  }
  return icon;
}

async function serveAddonIcon(request) {
  const url = new URL(request.url);
  const raw = url.pathname.replace(/^\/+/, '');

  let iconUrl;
  try {
    iconUrl = decodeURIComponent(raw);
  } catch {
    throw new Error('图标地址编码非法');
  }

  const icon = await loadAddonIcon(iconUrl);
  return new Response(new Uint8Array(icon.buffer), {
    headers: {
      'Content-Type': icon.contentType,
      'Content-Length': String(icon.buffer.length),
      // Chromium 对自定义协议的磁盘缓存不保证，真正的复用靠上面的内存表。
      'Cache-Control': 'public, max-age=86400'
    }
  });
}

function registerMediaProtocol() {
  protocol.handle('mcdl-media', async (request) => {
    try {
      if (new URL(request.url).hostname.toLowerCase() === ADDON_ICON_HOST) {
        return await serveAddonIcon(request);
      }
      return await serveWallpaperMedia(request);
    } catch (error) {
      console.warn('[media] 拒绝媒体请求:', request.url, error.message);
      return new Response('Forbidden', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  });
}

async function removeWallpaperEntry(payload, settings) {
  const kind = payload && payload.kind === 'video' ? 'video' : 'image';
  const name = String((payload && payload.name) || '');
  if (!name) throw new Error('缺少壁纸名称');

  if (kind === 'video') {
    // 视频是"引用"，不是拷贝：只清引用，绝不删用户的源文件。
    if (settings.wallMedia !== 'video' || !sameLocalPath(name, settings.wallFile)) {
      throw new Error('这不是当前的视频壁纸');
    }
    return;
  }

  if (path.basename(name) !== name) throw new Error('壁纸名称非法');
  if (!WALL_IMAGE_EXTS.has(path.extname(name).toLowerCase())) throw new Error('壁纸名称非法');

  const target = path.join(wallpaperRoot(), name);
  // realpath 之后再删：backgrounds 里如果有人放了 junction，字符串判断拦不住。
  const real = await pathGuard.assertInsideReal(wallpaperRoot(), target, '壁纸文件');
  await fs.rm(real, { force: true });
  await fs.rm(path.join(wallpaperThumbRoot(), wallpaperThumbName(name)), { force: true });
}

/**
 * 长任务取消：渲染层生成 taskId，随原有 IPC 一起传下来；主进程把 AbortController
 * 登记在表里，`task:cancel` 一到就 abort，mcdl 子进程会被 kill、fetch 会被中断。
 * 登记项同时带一个 done Promise，供退出流程等待任务真正收尾（见下面的 inFlightTasks）。
 */
const activeTasks = new Map();

const CANCEL_MESSAGE = '已取消';
const MAX_TASK_ID_LENGTH = 80;

/**
 * 退出时等任务的硬上限。
 *
 * 5 秒是个折中：mcdl 子进程被 kill、fetch 被 abort 之后，收尾（含原子写的 fsync）
 * 通常是几十毫秒；等太久会让用户以为「点了关闭没反应」，等太短则可能正好打断落盘。
 * 超时不是失败——日志里留一条 warn，然后照常退出（绝不无限等）。
 */
const TASKS_IDLE_TIMEOUT_MS = 5000;
/** 非任务型写入（设置保存 / 别名 / 壁纸）排队落盘的等待上限，短一些，别拖慢退出。 */
const WRITES_IDLE_TIMEOUT_MS = 3000;

/**
 * 每个任务除了 AbortController，还带一个 done Promise：
 * IPC handler 的 finally 里调用 finish() 时兑现，表示「这个任务的活（含写盘）真的干完了」。
 * 退出流程靠它判断能不能销毁窗口。
 *
 * activeTasks: taskId -> entry（task:cancel 与去重用）
 * inFlightTasks: entry 集合（取消后 activeTasks 会被清空，但任务本身可能还在收尾，
 *                所以退出等待必须看这个集合；size 就是 inFlight 计数）
 */
const inFlightTasks = new Set();

function inFlightCount() {
  return inFlightTasks.size;
}

function settleTask(entry) {
  if (!entry || entry.settled) return;
  entry.settled = true;
  inFlightTasks.delete(entry);
  entry.resolveDone();
}

function beginTask(taskId) {
  const id = String(taskId || '').trim();
  if (!id || id.length > MAX_TASK_ID_LENGTH) {
    return { id: '', signal: null, finish: () => {} };
  }

  // 同一个 id 重复登记时先把旧任务停掉，避免留下"永远挂着的孤儿进程"。
  const existing = activeTasks.get(id);
  if (existing) {
    try {
      existing.controller.abort();
    } catch {
      // 已经结束的任务不用管
    }
  }

  const controller = new AbortController();
  let resolveDone = () => {};
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const entry = { id, controller, done, resolveDone, settled: false };
  activeTasks.set(id, entry);
  inFlightTasks.add(entry);

  return {
    id,
    signal: controller.signal,
    finish: () => {
      if (activeTasks.get(id) === entry) activeTasks.delete(id);
      settleTask(entry);
    }
  };
}

function cancelAllTasks() {
  for (const entry of activeTasks.values()) {
    try {
      entry.controller.abort();
    } catch {
      // 已经结束的任务不用管
    }
  }
  // 只清「按 id 索引」的表：inFlightTasks 里的条目还要靠各自 handler 的 finally
  // 兑现 done，退出流程才能等到它们真正停下。
  activeTasks.clear();
}

/**
 * 取消全部在飞任务并等待它们结束（含写盘），最多等 timeoutMs。
 *
 * 不能只 await 一次快照：等待期间渲染层仍可能发起新任务（窗口还没销毁），
 * 所以循环到 inFlightTasks 为空或超过 deadline 为止。
 *
 * @returns {Promise<{timedOut: boolean, pending: number}>}
 */
async function waitForTasksIdle(timeoutMs = TASKS_IDLE_TIMEOUT_MS) {
  cancelAllTasks();

  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let timedOut = false;

  while (inFlightTasks.size > 0) {
    const pending = [...inFlightTasks].map((entry) => entry.done);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      break;
    }

    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), remaining);
    });
    try {
      const result = await Promise.race([
        Promise.allSettled(pending).then(() => 'idle'),
        timeout
      ]);
      if (result === 'timeout') {
        timedOut = true;
        break;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (timedOut) {
    console.warn(
      `[shutdown] ${inFlightTasks.size} 个任务在 ${timeoutMs}ms 内没有结束，继续退出（避免卡死）`
    );
  }
  return { timedOut, pending: inFlightTasks.size };
}

/**
 * 优雅退出状态机（只跑一次）。
 *
 *   allowQuit        false → close / before-quit 都必须拦下来等任务；true → 放行，别再拦
 *   shutdownPromise  非 null 表示「收尾已经启动」，它就是防重入锁
 *
 * 顺序很重要：先等到任务停下，再把 allowQuit 置位并销毁窗口。
 * 如果先销毁窗口，任务还在写盘，就回到事故现场了。
 */
let allowQuit = false;
let shutdownPromise = null;

/**
 * 取消在飞任务、等它们结束（最多 TASKS_IDLE_TIMEOUT_MS），然后销毁窗口 / 继续退出。
 *
 * 用 win.destroy() 而不是 win.close()：destroy 不触发 close，因此不会二次进入本流程，
 * 直接进 closed 做最后清理。
 */
function beginShutdown(reason) {
  if (shutdownPromise) return shutdownPromise;

  const win = mainWindow;
  const pending = inFlightCount();
  console.log(`[shutdown] 开始优雅退出（${reason}），在飞任务 ${pending} 个`);

  shutdownPromise = (async () => {
    if (pending > 0) {
      // 让渲染层有机会显示「正在收尾」；没有监听者也无害（渲染层未改）。
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send('window:closing', { reason, pending });
        } catch (error) {
          console.warn('[shutdown] 无法通知渲染层正在关闭:', error.message);
        }
      }

      const result = await waitForTasksIdle(TASKS_IDLE_TIMEOUT_MS);
      console.log(
        `[shutdown] 任务收尾结束（timedOut=${result.timedOut}, pending=${result.pending}），销毁窗口`
      );
    }

    // 非任务型写入（设置保存、别名、壁纸、皮肤缓存…）不登记在 activeTasks 里，
    // 但此刻可能正排队落盘：等它们写完，别留下 .tmp 孤儿。
    const flushed = await flushWrites(WRITES_IDLE_TIMEOUT_MS);
    if (flushed.timedOut) {
      console.warn(`[shutdown] 仍有 ${flushed.pending} 个写入未落盘，继续退出`);
    }

    allowQuit = true;

    if (win && !win.isDestroyed()) {
      win.destroy();
      // window:close 路径靠 window-all-closed 里的 app.quit() 收尾；
      // before-quit 路径（系统关机 / app.quit）在 macOS 上不会触发 window-all-closed，补一次。
      if (reason !== 'window:close') app.quit();
    } else {
      // 窗口已经没了（或从未创建）：已经没有 window-all-closed 可依赖，直接续上退出。
      app.quit();
    }
  })().catch((error) => {
    console.error('[shutdown] 收尾流程异常，直接销毁窗口:', error && error.message);
    allowQuit = true;
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    } catch (destroyError) {
      console.warn('[shutdown] 销毁窗口失败:', destroyError.message);
    }
    app.quit();
  });

  return shutdownPromise;
}

function isCancelledError(error) {
  return Boolean(error && (error.cancelled || error.name === 'AbortError' || error.code === 'TASK_CANCELLED'));
}

/** 把取消错误改写成用户能读懂、渲染层能识别的一句话。 */
function cancellationError() {
  const error = new Error(CANCEL_MESSAGE);
  error.cancelled = true;
  error.code = 'TASK_CANCELLED';
  return error;
}

/**
 * 文本框右键菜单：只放编辑命令，不拼任何页面数据。
 * 用 role 而不是 webContents.undo()，让 Chromium 自己处理编辑状态与输入法。
 */
function popTextContextMenu(win, params = {}) {
  const editable = Boolean(params.editable);
  const hasSelection = Boolean(params.hasSelection);
  const secret = Boolean(params.secret);   // 密码框：不提供剪切 / 复制 / 粘贴
  const x = Math.max(0, Math.round(Number(params.x) || 0));
  const y = Math.max(0, Math.round(Number(params.y) || 0));

  const menu = Menu.buildFromTemplate([
    { role: 'undo', label: '撤销', enabled: editable },
    { role: 'redo', label: '重做', enabled: editable },
    { type: 'separator' },
    { role: 'cut', label: '剪切', enabled: editable && hasSelection && !secret },
    { role: 'copy', label: '复制', enabled: hasSelection && !secret },
    { role: 'paste', label: '粘贴', enabled: editable && !secret },
    { role: 'delete', label: '删除', enabled: editable && hasSelection },
    { type: 'separator' },
    { role: 'selectAll', label: '全选', enabled: true }
  ]);

  menu.popup({
    window: win,
    x,
    y,
    callback: () => {
      // 菜单是一次性的，关掉后立刻释放，别等 GC。
      try {
        menu.destroy();
      } catch {
        // ignore
      }
    }
  });

  return true;
}

function registerIpcHandlers() {
  ipcMain.handle('ui:context-menu', (event, payload = {}) => {
    const win = assertAppWindow(event);
    return popTextContextMenu(win, payload || {});
  });

  ipcMain.handle('task:cancel', (event, taskId) => {
    assertAppWindow(event);
    const task = activeTasks.get(String(taskId || '').trim());
    if (!task) return false;
    task.controller.abort();
    return true;
  });

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
    // 只发一个真正的 close 请求：是否等待在飞任务由窗口的 'close' 事件统一裁决。
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

  // 扫描缓存只影响「扫描其他启动器」，清理它不会碰任何游戏文件。
  ipcMain.handle('instances:scan-cache', async (event) => {
    assertAppWindow(event);
    return await readScanCacheState();
  });

  ipcMain.handle('instances:scan-cache-clear', async (event) => {
    assertAppWindow(event);
    try {
      return await clearScanCache();
    } catch (error) {
      console.error('[instances] clear scan cache failed:', error);
      throw new Error(`清理扫描缓存失败: ${error.message}`);
    }
  });

  ipcMain.handle('instances:scan-cache-forget', async (event, dir) => {
    assertAppWindow(event);
    return await forgetScanCacheDir(dir);
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
    const task = beginTask(payload.taskId);

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
          signal: task.signal,
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
        signal: task.signal,
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
      if (isCancelledError(error)) {
        if (!win.isDestroyed()) {
          win.webContents.send('instances:install-progress', { message: CANCEL_MESSAGE });
        }
        throw cancellationError();
      }
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
    } finally {
      task.finish();
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

    // 默认装到主游戏目录；「更新整合包」会把目标实例的 gameDir 传进来（必须已登记）。
    const gameDir = payload && payload.gameDir
      ? await assertGameDirAllowed(payload.gameDir)
      : await mcdl.detectGameDir();
    const bufferState = { value: '' };
    const task = beginTask(payload.taskId);
    const send = (message) => {
      if (!win.isDestroyed()) win.webContents.send('downloads:progress', { message });
    };

    send('准备安装整合包…');

    try {
      const result = await mcdl.installModpack({
        file: record.file,
        name: requestedName,
        gameDir,
        signal: task.signal,
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
      if (isCancelledError(error)) {
        send(CANCEL_MESSAGE);
        throw cancellationError();
      }
      console.error('[downloads] modpack install failed:', error);
      if (error && error.stdout) {
        console.error('[downloads] mcdl stdout tail:\n' + String(error.stdout).split(/\r?\n/).slice(-30).join('\n'));
      }
      send(`安装失败：${error.message}`);
      throw error;
    } finally {
      task.finish();
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
    const task = beginTask(payload.taskId);

    try {
      const version = await modrinth.getVersion(versionId);
      const folder = await getInstanceStore().folderFor(instance, ADDON_KINDS[kind]);
      const result = await modrinth.downloadVersion({
        version,
        targetDir: folder,
        installDependencies: Boolean(payload.installDependencies) && kind === 'mods',
        gameVersion: instance.versionName || '',
        loader: loaderKeyForInstance(instance),
        signal: task.signal,
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
      if (isCancelledError(error)) {
        send({ message: CANCEL_MESSAGE });
        throw cancellationError();
      }
      console.error('[addons] install failed:', error);
      if (!win.isDestroyed()) {
        win.webContents.send('downloads:addon-progress', { message: `安装失败：${error.message}` });
      }
      throw error;
    } finally {
      task.finish();
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
    const task = beginTask(payload.taskId);
    try {
      const result = await modrinth.downloadVersion({
        version,
        targetDir: picked.filePaths[0],
        installDependencies: false,
        signal: task.signal,
        onProgress: (progress) => {
          if (!win.isDestroyed()) win.webContents.send('downloads:addon-progress', progress);
        }
      });

      return { folder: picked.filePaths[0], ...result };
    } finally {
      task.finish();
    }
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
    // 隔离实例打开的是游戏实际使用的目录（mods / config / saves 都在这里）。
    const dir = (await instanceGameDirOf(instance)) || instance.gameDir;
    return { path: await openFolderPath(dir) };
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
    const baseDir = instance.gameDir || (await mcdl.detectGameDir());
    const gameDir = (await instanceGameDirOf(instance)) || baseDir;

    // 用占位符代替真实令牌：plan.args 里所有出现令牌的地方都会被替换掉。
    const scriptAccount = { ...account, accessToken: launchScript.TOKEN_PLACEHOLDER };

    const plan = await launcher.buildLaunchPlan({
      gameDir: baseDir,
      instanceDir: gameDir,
      instanceId: versionId,
      account: scriptAccount,
      settings,
      dataDir: app.getPath('userData'),
      resolveJava: (options) => resolveJavaRuntime({ ...options, javaPath: settings.javaPath })
    });

    // 生成脚本同样要过闸门：一个必然启动失败的 .bat 比「不生成」更糟——
    // 用户双击之后拿到的又是一句「闪退」，而且这次连启动器日志都没有。
    const scriptPreflight = await launcher.verifyLaunchPlan(plan, {
      hashCheck: launcher.hashModeFromSettings(settings)
    });
    if (!scriptPreflight.ok) {
      const error = new Error(scriptPreflight.summary.message);
      error.code = 'LAUNCH_PREFLIGHT_FAILED';
      throw error;
    }

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
      await writeFileAtomic(target, '\uFEFF' + files.ps1Text, 'utf8');
      await writeFileAtomic(batTarget, files.batText, 'utf8');
      await writeFileAtomic(dataTarget, files.dataText, 'utf8');
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
    const store = getGameDirStore();
    const targetId = String(id || '');

    // remove() 只回剩余列表，删完就查不到这条路径了，所以先记下来。
    let removedPath = '';
    try {
      const current = await store.list();
      const entry = (current && Array.isArray(current.dirs) ? current.dirs : [])
        .find((item) => item.id === targetId);
      if (entry && entry.path) removedPath = entry.path;
    } catch {
      removedPath = '';
    }

    const result = await store.remove(targetId);

    // 顺带把它从「扫描其他启动器」缓存里剔掉，否则删掉的目录下次扫描又会冒出来。
    if (removedPath) {
      await forgetScanCacheDir(removedPath).catch((error) => {
        console.warn('[gamedirs] could not forget scan cache entry:', error);
      });
    }

    return result;
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

  // ---------------- 实例详情：截图管理 ----------------

  const SCREENSHOT_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
  const SCREENSHOT_MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  };
  const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
  const MAX_SCREENSHOT_TOTAL = 160 * 1024 * 1024;
  const MAX_SCREENSHOTS = 240;

  async function screenshotRoot(instance) {
    return getInstanceStore().folderFor(instance, 'screenshots');
  }

  async function resolveScreenshot(instance, rawPath) {
    const root = await screenshotRoot(instance);
    const real = await pathGuard.assertInsideReal(root, String(rawPath || ''), '截图文件');
    const stat = await fs.stat(real).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error('截图不存在或已被删除');
    if (!SCREENSHOT_EXTS.has(path.extname(real).toLowerCase())) throw new Error('这不是支持的截图格式');
    return { root, real, stat };
  }

  /**
   * 截图列表：直接给 data URL。
   *
   * 截图是用户自己的图片，走不了 mcdl-media://（那个协议只服务壁纸 / 图标），
   * 所以按总量预算内联成 data URL；超过 16 MB 的单张跳过，避免把渲染进程撑爆。
   */
  ipcMain.handle('instances:screenshots', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    const root = await screenshotRoot(instance);

    let dirents = [];
    try {
      dirents = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return { root, exists: false, entries: [], skipped: 0, total: 0 };
    }

    const entries = [];
    let budget = 0;
    let skipped = 0;

    for (const dirent of dirents) {
      if (entries.length >= MAX_SCREENSHOTS) break;
      if (!dirent.isFile()) continue;
      if (!SCREENSHOT_EXTS.has(path.extname(dirent.name).toLowerCase())) continue;

      const full = path.join(root, dirent.name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (stat.size > MAX_SCREENSHOT_BYTES || budget + stat.size > MAX_SCREENSHOT_TOTAL) {
        skipped += 1;
        continue;
      }

      let dataUrl = '';
      try {
        const buffer = await fs.readFile(full);
        dataUrl = `data:${SCREENSHOT_MIME[path.extname(full).toLowerCase()] || 'image/png'};base64,${buffer.toString('base64')}`;
        budget += stat.size;
      } catch {
        continue;
      }

      entries.push({
        name: dirent.name,
        path: full,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        dataUrl
      });
    }

    entries.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
    return { root, exists: true, entries, skipped, total: budget };
  });

  /** 截图 → 剪贴板（HMCL 截图菜单的「复制」）。 */
  ipcMain.handle('screenshots:copy', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    const { real } = await resolveScreenshot(instance, payload.path);

    const image = nativeImage.createFromPath(real);
    if (image.isEmpty()) throw new Error('这张截图无法读取为图片');
    clipboard.writeImage(image);
    return { path: real };
  });

  /** 截图 → 启动器背景（复用壁纸的导入 / 设置管线）。 */
  ipcMain.handle('screenshots:set-wallpaper', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    const { real } = await resolveScreenshot(instance, payload.path);

    const imported = await importWallpaperImage(real);
    const settings = await writeSettings(
      { wallMode: 'custom', wallMedia: 'image', wallFile: imported.name },
      { trustWallFile: true }
    );
    return { settings, ...(await listWallpapers(settings)), item: { kind: 'image', label: imported.label, size: imported.size } };
  });

  // ---------------- 实例详情：管理菜单（清理 / 资源 / 库） ----------------

  async function measureDir(dir) {
    let total = 0;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await measureDir(full);
      else if (entry.isFile()) total += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
    }
    return total;
  }

  /** 只清空内容、保留目录本身：游戏和启动器都会继续往这些目录写日志。 */
  async function clearDirectory(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      await fs.rm(full, { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
    return removed;
  }

  ipcMain.handle('instances:maintenance', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const instance = await requireInstance(payload);
    const action = String(payload.action || 'clean');

    // baseDir：assets / libraries 所在的基础游戏目录；
    // gameDir：游戏实际游戏目录（隔离实例的 logs / crash-reports 在这里）。
    const baseDir = path.resolve(instance.gameDir || '');
    const versionDir = path.resolve(instance.path || '');
    if (!baseDir || !versionDir) throw new Error('实例路径不完整');
    const gameDir = path.resolve((await instanceGameDirOf(instance)) || baseDir);

    if (action === 'redownload-assets') {
      const mcVersion = String(instance.versionName || '').trim();
      if (!mcVersion) throw new Error('无法确定这个实例的 Minecraft 版本');
      const settings = await readSettings();
      const task = beginTask(payload.taskId);
      const bufferState = { value: '' };
      const send = (text) => sendInstallOutput(win, bufferState, 'instances:install-progress')(text);

      try {
        await mcdl.installVersion({
          version: mcVersion,
          gameDir: baseDir,
          source: settings.downloadSource,
          assets: true,
          assetsOnly: true,
          verify: true,
          signal: task.signal,
          onData: send
        });
        return { ok: true, action, message: `已更新 ${mcVersion} 的资源文件` };
      } catch (error) {
        if (isCancelledError(error)) throw cancellationError();
        throw error;
      } finally {
        task.finish();
      }
    }

    const targets = [];
    if (action === 'remove-assets') {
      targets.push({ dir: path.join(baseDir, 'assets'), label: '游戏资源文件 assets' });
    } else if (action === 'remove-libraries') {
      targets.push({ dir: path.join(baseDir, 'libraries'), label: '库文件 libraries' });
    } else if (action === 'clean') {
      const sameDir = gameDir.toLowerCase() === baseDir.toLowerCase();
      targets.push(
        { dir: path.join(baseDir, 'logs'), label: '日志 logs', keepDir: true },
        { dir: path.join(baseDir, 'crash-reports'), label: '崩溃报告 crash-reports', keepDir: true }
      );
      // 隔离实例的实际日志在 versions/<id>/ 下，和基础目录不是同一个地方。
      if (!sameDir) {
        targets.push(
          { dir: path.join(gameDir, 'logs'), label: '实例日志', keepDir: true },
          { dir: path.join(gameDir, 'crash-reports'), label: '实例崩溃报告', keepDir: true }
        );
      }
      targets.push(
        { dir: path.join(versionDir, 'logs'), label: '实例日志', keepDir: true },
        { dir: path.join(versionDir, 'crash-reports'), label: '实例崩溃报告', keepDir: true },
        { dir: path.join(versionDir, 'natives'), label: '解压出的 natives' },
        { dir: path.join(versionDir, '.mcdl-import.json'), label: '安装断点状态', isFile: true }
      );
    } else {
      throw new Error(`不支持的管理动作：${action}`);
    }

    const removed = [];
    let freed = 0;

    // 同一目录可能既被「基础目录」又被「实例目录」列到（隔离实例两者相同），
    // 去重后只清理一次，避免重复计数 / 重复条目。
    const seenDirs = new Set();
    for (const target of targets) {
      const key = path.resolve(target.dir).toLowerCase();
      if (seenDirs.has(key)) continue;
      seenDirs.add(key);

      const stat = await fs.stat(target.dir).catch(() => null);
      if (!stat) continue;

      if (target.isFile) {
        freed += stat.size;
        await fs.rm(target.dir, { force: true }).catch(() => {});
        removed.push(target.label);
        continue;
      }
      if (!stat.isDirectory()) continue;

      if (target.keepDir) {
        const bytes = await measureDir(target.dir);
        const count = await clearDirectory(target.dir);
        if (count > 0) {
          freed += bytes;
          removed.push(`${target.label}（${count} 项）`);
        }
      } else {
        const bytes = await measureDir(target.dir);
        await fs.rm(target.dir, { recursive: true, force: true });
        freed += bytes;
        removed.push(target.label);
      }
    }

    return { ok: true, action, removed, freed, freedLabel: formatBytes(freed) };
  });

  // ---------------- 实例详情：更新整合包 ----------------

  /**
   * 把「新整合包安装出来的临时实例」的内容合并进目标实例，然后删掉临时实例。
   *
   * 为什么不直接原地升级：mcdl 的 --install-pack 会新建 versions/<name>（同名但包 SHA-1
   * 不同时会退化成 <name> (2)），没有「覆盖已有实例」的入口。这里复用它的安装 +
   * 解压核对，再在同目录内做一次覆盖复制，行为等价于「用新包的 overrides 覆盖旧实例」。
   */
  async function copyTreeInto(source, dest, stats) {
    const entries = await fs.readdir(source, { withFileTypes: true });
    await fs.mkdir(dest, { recursive: true });
    for (const entry of entries) {
      const from = path.join(source, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await copyTreeInto(from, to, stats);
      } else if (entry.isFile()) {
        await fs.copyFile(from, to);
        stats.files += 1;
        stats.bytes += (await fs.stat(from).catch(() => ({ size: 0 }))).size;
      }
    }
  }

  ipcMain.handle('instances:merge-pack', async (event, payload = {}) => {
    assertAppWindow(event);
    const target = await requireInstance(payload);
    const stagingName = String(payload.stagingName || '').trim();
    if (!stagingName || stagingName.length > 120 || /[\\/:*?"<>|\u0000-\u001f]/.test(stagingName)) {
      throw new Error('临时实例名非法');
    }

    // 临时实例刚由 install-pack 建出来，按「同一个游戏目录 + versions 下的文件夹名」定位，
    // 不依赖渲染层拼好的 id（外部目录的 id 带 @hash 后缀，拼错就会误删别的实例）。
    const targetGameDir = path.resolve(target.gameDir || '');
    const snapshot = await rescanInstances();
    const staging = snapshot.instances.find((item) => (
      item.gameDir &&
      path.resolve(item.gameDir) === targetGameDir &&
      path.basename(item.path) === stagingName
    ));

    if (!staging) throw new Error('找不到刚安装的临时实例，可能已被删除');
    if (staging.id === target.id) throw new Error('不能把整合包合并到它自己');

    const versionsRoot = path.join(targetGameDir, 'versions');
    const stagingPath = path.resolve(staging.path);
    const targetPath = path.resolve(target.path);
    if (path.dirname(stagingPath) !== versionsRoot || path.dirname(targetPath) !== versionsRoot) {
      throw new Error('实例目录不在 versions 下，已取消合并');
    }

    const stats = { files: 0, bytes: 0 };
    await copyTreeInto(stagingPath, targetPath, stats);

    await fs.rm(stagingPath, { recursive: true, force: true });

    const aliases = await readAliases();
    delete aliases[stagingPath];
    await writeAliases(aliases).catch(() => {});

    const next = await rescanInstances(target.id);
    return {
      ok: true,
      files: stats.files,
      bytes: stats.bytes,
      freedLabel: formatBytes(stats.bytes),
      snapshot: next
    };
  });

  // ---------------- 导出整合包 ----------------

  ipcMain.handle('modpack:scan', async (event, payload = {}) => {
    assertAppWindow(event);
    const instance = await requireInstance(payload);
    return modpackExport.scanInstance(instance);
  });

  ipcMain.handle('modpack:export', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const instance = await requireInstance(payload);

    const scan = await modpackExport.scanInstance(instance);
    const format = payload.format === 'modrinth' ? 'modrinth' : 'curseforge';
    const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
    const flags = payload.options && typeof payload.options === 'object' ? payload.options : {};
    const selection = Array.isArray(payload.selection) ? payload.selection.map(String) : [];

    if (selection.length === 0) throw new Error('至少勾选一个文件夹');

    const baseName = modpackExport.sanitizeFileName(
      `${meta.name || scan.name}-${meta.version || scan.suggestedVersion || '1.0.0'}`
    );
    const result = await dialog.showSaveDialog(win, {
      title: '导出整合包',
      defaultPath: path.join(app.getPath('documents'), `${baseName}.zip`),
      filters: [{ name: '整合包', extensions: ['zip'] }]
    });
    if (result.canceled || !result.filePath) return null;

    let targetFile = result.filePath;
    if (!targetFile.toLowerCase().endsWith('.zip')) targetFile += '.zip';

    const task = beginTask(payload.taskId);
    const send = (message, percent) => {
      if (!win.isDestroyed()) win.webContents.send('modpack:export-progress', { message, percent });
    };

    // 先写同目录下的临时文件，成功后再改名覆盖目标：
    // 失败 / 取消时只删自己的临时文件，绝不误删用户已经存在的同名 zip。
    const tempFile = path.join(path.dirname(targetFile), `.mcdl-export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.zip`);

    try {
      const exported = await modpackExport.exportPack({
        instance,
        scan,
        format,
        selection,
        meta,
        options: {
          server: typeof flags.server === 'string' ? flags.server : '',
          forceUpdate: Boolean(flags.forceUpdate),
          includeLauncher: Boolean(flags.includeLauncher),
          noRemoteMatch: Boolean(flags.noRemoteMatch),
          skipCurseforge: Boolean(flags.skipCurseforge)
        },
        targetFile: tempFile,
        signal: task.signal,
        onProgress: send
      });

      await fs.rename(tempFile, targetFile).catch(async (error) => {
        // 跨卷或目标被占用时 rename 会失败：退回复制 + 删临时文件。
        if (error && (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'EEXIST')) {
          await fs.copyFile(tempFile, targetFile);
          await fs.rm(tempFile, { force: true }).catch(() => {});
          return;
        }
        throw error;
      });

      await revealPath(targetFile).catch(() => {});
      return { ...exported, file: targetFile };
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => {});
      if (isCancelledError(error)) throw cancellationError();
      console.error('[export] modpack export failed:', error);
      throw error;
    } finally {
      task.finish();
    }
  });

  // ---------------- 安装 Java（Adoptium） ----------------

  ipcMain.handle('java:install', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const major = javaInstall.SUPPORTED_MAJORS.includes(Number(payload.major))
      ? Number(payload.major)
      : 21;

    const task = beginTask(payload.taskId);
    const send = (message, percent) => {
      if (!win.isDestroyed()) win.webContents.send('java:install-progress', { message, percent });
    };

    try {
      const installed = await javaInstall.installJava({
        major,
        destRoot: path.join(app.getPath('userData'), 'java'),
        onProgress: send,
        signal: task.signal
      });

      // 我们自己下载并解压出来的 java.exe：授权表里没有它，直接登记一次。
      // 这是「启动器自己产出的可执行文件」，等价于枚举到的本机 Java。
      const { info, record } = await javaRuntime.registerJava(installed.javaPath);
      send(`已登记 Java ${info.major}：${record.real}`, 100);
      return {
        path: record.real,
        info,
        identity: await javaRuntime.javaAuthorization(record.real),
        reused: installed.reused,
        url: installed.url
      };
    } catch (error) {
      if (isCancelledError(error)) throw cancellationError();
      console.error('[java] install failed:', error);
      throw error;
    } finally {
      task.finish();
    }
  });

  // ---------------- NBT 编辑器 ----------------

  // 路径只认「主进程自己弹对话框选出来的那个文件」：token 一次性生成，30 分钟有效。
  const nbtTokens = new Map();
  const NBT_TOKEN_TTL = 30 * 60 * 1000;

  function issueNbtToken(file) {
    const now = Date.now();
    for (const [token, entry] of nbtTokens.entries()) {
      if (now - entry.at > NBT_TOKEN_TTL) nbtTokens.delete(token);
    }
    const token = crypto.randomBytes(16).toString('hex');
    nbtTokens.set(token, { file, at: now });
    return token;
  }

  function resolveNbtToken(token) {
    const entry = nbtTokens.get(String(token || ''));
    if (!entry) throw new Error('NBT 编辑会话已过期，请重新选择文件');
    if (Date.now() - entry.at > NBT_TOKEN_TTL) {
      nbtTokens.delete(String(token));
      throw new Error('NBT 编辑会话已过期，请重新选择文件');
    }
    entry.at = Date.now();
    return entry.file;
  }

  ipcMain.handle('nbt:pick', async (event) => {
    const win = assertAppWindow(event);
    const result = await dialog.showOpenDialog(win, {
      title: '选择要编辑的 NBT 文件',
      properties: ['openFile'],
      filters: [
        { name: 'NBT 数据', extensions: ['dat', 'nbt', 'schematic', 'schem'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;

    const file = pathGuard.assertLocalPath(result.filePaths[0], 'NBT 文件');
    const loaded = await nbtEditor.load(file);
    return { token: issueNbtToken(file), file, ...loaded };
  });

  ipcMain.handle('nbt:save', async (event, payload = {}) => {
    assertAppWindow(event);
    const file = resolveNbtToken(payload.token);
    return nbtEditor.save(file, payload.edits);
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

  // ---------------- 崩溃恢复页（renderer/recovery.html） ----------------
  //
  // 恢复页是零依赖的静态页：它不能假设主包（React/Vue/我们的 renderer.js）还能跑，
  // 因为主包本身可能就是崩溃原因。所以这三个方法是它唯一的后端能力。

  /** 重新加载主界面。 */
  ipcMain.handle('recovery:reload', async (event) => {
    assertAppWindow(event);
    loadMainPage();
    return { ok: true };
  });

  /**
   * 重置工作区：只清 Chromium 侧的缓存与界面状态，不动账号、实例、存档。
   * 白屏 / 崩溃循环最常见的原因就是 profile 里的缓存或 Local Storage 坏了。
   */
  ipcMain.handle('recovery:reset-workspace', async (event) => {
    assertAppWindow(event);

    const userData = app.getPath('userData');
    const targets = [
      'Cache',
      'Code Cache',
      'GPUCache',
      'GPUPersistentCache',
      'DawnGraphiteCache',
      'DawnWebGPUCache',
      'ShaderCache',
      'GrShaderCache',
      'Local Storage',
      'Session Storage',
      'Shared Dictionary',
      'Partitions',
      'Preferences',
      'gpu-crash.json'
    ];

    const removed = [];
    const failed = [];

    for (const name of targets) {
      // 只删 userData 下的固定名字，不拼接任何外部输入。
      const target = path.join(userData, name);
      try {
        await fs.rm(target, { recursive: true, force: true });
        removed.push(name);
      } catch (error) {
        failed.push({ name, message: error.message });
      }
    }

    appLog.append('WARN', `[recovery] workspace reset: removed=${removed.join(',')} failed=${failed.length}`);

    // 清完立刻重载，让用户看到的是「好了」而不是一个还在的恢复页。
    setImmediate(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        // 缓存被删了，必须重开一次 session 才会重新落盘；reload 足够。
        loadMainPage();
      }
    });

    return { ok: failed.length === 0, removed, failed };
  });

  /** 导出诊断：崩溃现场 + 启动器日志尾部 + 环境信息，落到桌面。 */
  ipcMain.handle('recovery:export-diagnostics', async (event) => {
    const win = assertAppWindow(event);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(app.getPath('desktop'), `mcdl-launcher-diagnostics-${stamp}.txt`);

    const appLogText = appLog.tail(2000);
    const gpu = readGpuCrashMarker();
    const result = await dialog.showSaveDialog(win, {
      title: '导出诊断信息',
      defaultPath: target,
      filters: [{ name: '文本文件', extensions: ['txt', 'log'] }]
    }).catch(() => ({ canceled: true }));
    if (result.canceled || !result.filePath) return null;

    const bundle = [
      'MCDL Launcher · 崩溃恢复诊断',
      '============================',
      '',
      `时间：${new Date().toISOString()}`,
      `应用版本：${app.getVersion()}`,
      `Electron：${process.versions.electron}  Chrome：${process.versions.chrome}  Node：${process.versions.node}`,
      `平台：${process.platform} ${process.arch} ${require('node:os').release()}`,
      `渲染模式：${RENDER_MODE}`,
      `数据目录：${app.getPath('userData')}`,
      '',
      `渲染进程崩溃记录（最近一次窗口）：${rendererCrashes.length} 次`,
      rendererCrashes.map((at) => `  - ${new Date(at).toISOString()}`).join('\n') || '  （无）',
      '',
      'GPU 崩溃标记：',
      gpu ? JSON.stringify(gpu, null, 2) : '（无）',
      '',
      '===== 启动器日志（尾部 200KB） =====',
      appLogText || '（没有日志）',
      ''
    ].join('\n');

    await writeFileAtomic(result.filePath, bundle, 'utf8');
    await revealPath(result.filePath).catch(() => {});
    return { file: result.filePath, size: Buffer.byteLength(bundle, 'utf8') };
  });

  ipcMain.handle('shell:open-logs', async (event) => {
    assertAppWindow(event);
    // 走和「打开文件夹」同一条路径：存在性 / 可读性预检 + explorer 直启 + 返回值检查
    // 现在主进程的 console.* 与未捕获异常都会落到 userData/logs，这里打开的就是那个目录。
    await openFolderPath(appLog.dir() || app.getPath('logs'));
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

  // ---------------- 日志 / 崩溃 / 任务栈 ----------------

  /**
   * 最近一次启动的上下文。
   *
   * 日志窗口要能回答三个问题：这次启动的日志在哪、进程还活着吗、崩溃报告在哪。
   * launch.js 的 activeLaunches 只保留运行中的进程，退出后就没了，所以这里另存一份
   * 最近 N 次的快照（含已退出）。
   */
  const recentLaunches = [];
  const stoppedLaunches = new Set();
  const MAX_RECENT_LAUNCHES = 12;

  function rememberLaunch(entry) {
    recentLaunches.unshift(entry);
    if (recentLaunches.length > MAX_RECENT_LAUNCHES) recentLaunches.length = MAX_RECENT_LAUNCHES;
  }

  function markLaunchExited(launchId, patch) {
    const entry = recentLaunches.find((item) => item.launchId === launchId);
    if (!entry) return;
    Object.assign(entry, patch || {}, { exited: true, exitedAt: Date.now() });
  }

  function currentLaunchEntry() {
    return recentLaunches[0] || null;
  }

  async function newestLauncherLog(gameDir) {
    const dir = path.join(path.resolve(gameDir), 'logs');
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    let best = null;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/^mcdl-launcher-.*\.log$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { file: full, mtimeMs: stat.mtimeMs, size: stat.size };
      }
    }
    return best;
  }

  /** 读文件尾部（按字节截断，再对齐到行边界）。 */
  async function readTail(file, maxBytes = 512 * 1024) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return { text: '', truncated: false, size: 0 };
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.open(file, 'r');
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let text = buffer.toString('utf8');
      if (start > 0) {
        const index = text.indexOf('\n');
        text = index >= 0 ? text.slice(index + 1) : text;
      }
      return { text, truncated: start > 0, size: stat.size };
    } finally {
      await handle.close();
    }
  }

  /** 本次启动之后新产生的崩溃报告（没有就返回空串）。 */
  async function findCrashReport(gameDir, since) {
    const dir = path.join(path.resolve(gameDir || ''), 'crash-reports');
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return '';
    }

    let best = null;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.txt')) continue;
      const full = path.join(dir, entry.name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (since && stat.mtimeMs < since - 5000) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: stat.mtimeMs };
    }
    return best ? best.file : '';
  }

  /**
   * 日志窗口打开时的一次性快照。
   *
   * 优先用本次会话最近一次启动的日志；启动器刚打开、还没启动过游戏时，
   * 退回「该游戏目录下最新的 mcdl-launcher-*.log」，这样窗口不会一片空白。
   */
  ipcMain.handle('logs:tail', async (event, payload = {}) => {
    assertAppWindow(event);

    const activeList = launcher.listActiveLaunches();
    const activeIds = new Set(activeList.map((item) => item.launchId));
    let entry = currentLaunchEntry();

    // 指定的实例不是本次会话最后启动的那个：不要拿 A 的日志冒充 B 的。
    if (entry && payload.instanceId && entry.instanceId && entry.instanceId !== payload.instanceId) {
      entry = null;
    }

    if (!entry && payload.instanceId) {
      try {
        const instance = await requireInstance(payload);
        // 启动日志写在「这次启动用的游戏目录」下：隔离实例是 versions/<id>/logs。
        const gameDir = (await instanceGameDirOf(instance)) || instance.gameDir || '';
        entry = {
          launchId: '',
          logFile: (await newestLauncherLog(gameDir))?.file || '',
          gameDir,
          instanceId: instance.id,
          versionId: instance.versionName || '',
          startedAt: 0,
          exited: true
        };
      } catch {
        entry = null;
      }
    }

    if (!entry) {
      const own = await mcdl.detectGameDir();
      const newest = await newestLauncherLog(own);
      entry = newest
        ? { launchId: '', logFile: newest.file, gameDir: own, instanceId: '', versionId: '', startedAt: 0, exited: true }
        : null;
    }

    if (!entry || !entry.logFile) {
      return {
        file: '',
        text: '',
        truncated: false,
        active: false,
        launch: null,
        appLogFile: appLog.file(),
        appLogDir: appLog.dir()
      };
    }

    const tail = await readTail(entry.logFile);
    return {
      file: entry.logFile,
      text: tail.text,
      truncated: tail.truncated,
      size: tail.size,
      active: Boolean(entry.launchId && activeIds.has(entry.launchId) && !entry.exited),
      launch: {
        launchId: entry.launchId || '',
        instanceId: entry.instanceId || '',
        versionId: entry.versionId || '',
        gameDir: entry.gameDir || '',
        startedAt: entry.startedAt || 0,
        exited: Boolean(entry.exited)
      },
      appLogFile: appLog.file(),
      appLogDir: appLog.dir()
    };
  });

  /** 日志导出：把当前视图（或传进来的文本）存成文件，顺手在资源管理器里定位。 */
  ipcMain.handle('logs:export', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const text = typeof payload.text === 'string' ? payload.text : '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const defaultName = safeFileName(String(payload.defaultName || `mcdl-launcher-${stamp}.log`)) || `mcdl-launcher-${stamp}.log`;

    const result = await dialog.showSaveDialog(win, {
      title: '导出日志',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: '日志文件', extensions: ['log', 'txt'] }, { name: '全部文件', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePath) return null;

    let content = text;
    if (!content) {
      const entry = currentLaunchEntry();
      if (entry && entry.logFile) content = (await readTail(entry.logFile, 8 * 1024 * 1024)).text;
    }
    if (!content) content = appLog.tail(4000);

    await writeFileAtomic(result.filePath, content, 'utf8');
    await revealPath(result.filePath).catch(() => {});
    return { file: result.filePath, size: Buffer.byteLength(content, 'utf8') };
  });

  /** 打开「日志文件夹」：scope=app（启动器日志）/ game（游戏日志）。 */
  ipcMain.handle('logs:open-folder', async (event, payload = {}) => {
    assertAppWindow(event);
    const scope = payload.scope === 'game' ? 'game' : 'app';

    if (scope === 'app') {
      const dir = appLog.dir() || app.getPath('logs');
      await openFolderPath(dir);
      return { path: dir, scope };
    }

    let gameDir = '';
    if (payload.instanceId) {
      const instance = await requireInstance(payload);
      gameDir = (await instanceGameDirOf(instance)) || instance.gameDir || '';
    }
    if (!gameDir) gameDir = currentLaunchEntry()?.gameDir || await mcdl.detectGameDir();

    const dir = path.join(gameDir, 'logs');
    await openFolderPath(dir);
    return { path: dir, scope };
  });

  /** 导出游戏运行栈：优先 jstack；没有就退回启动器侧的进程信息 + 日志尾部。 */
  ipcMain.handle('logs:dump', async (event, payload = {}) => {
    assertAppWindow(event);
    const activeList = launcher.listActiveLaunches();
    const wanted = String(payload.launchId || '');
    const active = activeList.find((item) => item.launchId === wanted) ||
      activeList.find((item) => item.launchId === (currentLaunchEntry()?.launchId || '')) ||
      activeList[0] || null;

    const lines = [];
    lines.push('MCDL Launcher · 游戏运行栈导出');
    lines.push('时间：' + new Date().toISOString());
    lines.push('');

    if (!active) {
      lines.push('当前没有正在运行的游戏进程。');
      lines.push('下面是最近一次启动的日志尾部，仅供参考：');
      lines.push('');
      const entry = currentLaunchEntry();
      if (entry && entry.logFile) {
        const tail = await readTail(entry.logFile, 64 * 1024);
        lines.push(tail.text.split(/\r?\n/).slice(-200).join('\n'));
      } else {
        lines.push('（没有找到启动日志）');
      }
      return { text: lines.join('\n'), source: 'launcher', pid: null, active: false };
    }

    lines.push(`launchId：${active.launchId}`);
    lines.push(`PID：${active.pid || '-'}`);
    lines.push(`版本：${active.versionId || '-'}`);
    lines.push(`启动时间：${active.startedAt ? new Date(active.startedAt).toISOString() : '-'}`);
    lines.push(`日志：${active.logFile || '-'}`);
    lines.push('');

    let source = 'launcher';
    if (active.pid && active.javaPath) {
      const jstack = path.join(path.dirname(active.javaPath), 'jstack.exe');
      if (await fs.stat(jstack).then((stat) => stat.isFile()).catch(() => false)) {
        try {
          const output = await new Promise((resolve, reject) => {
            execFile(jstack, ['-l', String(active.pid)], { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
              if (error && !stdout && !stderr) reject(error);
              else resolve(String(stdout || '') + String(stderr || ''));
            });
          });
          lines.push(`===== jstack (${jstack}) =====`);
          lines.push(output.trim());
          source = 'jstack';
        } catch (error) {
          lines.push(`jstack 执行失败：${error.message}`);
        }
      } else {
        lines.push(`没有找到 jstack.exe（${path.dirname(active.javaPath)}），改用启动器侧信息。`);
      }
    }

    if (source !== 'jstack') {
      lines.push('===== 进程信息 =====');
      lines.push(`可执行文件：${active.javaPath || '-'}`);
      lines.push('');
      lines.push('===== 日志尾部 200 行 =====');
      if (active.logFile) {
        const tail = await readTail(active.logFile, 128 * 1024);
        lines.push(tail.text.split(/\r?\n/).slice(-200).join('\n'));
      } else {
        lines.push('（没有找到启动日志）');
      }
    }

    return { text: lines.join('\n'), source, pid: active.pid || null, active: true };
  });

  /** 把一段文本放进系统剪贴板（渲染层 file:// 下 navigator.clipboard 不可靠）。 */
  ipcMain.handle('ui:copy-text', async (event, payload = {}) => {
    assertAppWindow(event);
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text) throw new Error('没有可复制的内容');
    clipboard.writeText(text);
    return text.length;
  });

  /**
   * 游戏崩溃信息导出：把崩溃报告 + 日志尾部打成一个文本包，用户选保存位置。
   */
  ipcMain.handle('crash:export', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    let instance = null;
    if (payload.instanceId) {
      instance = await requireInstance(payload).catch(() => null);
    }

    // 崩溃报告 / 日志只接受「该游戏目录下 crash-reports / logs 里」的文件：
    // 否则渲染进程可以把任意本地文本塞进导出包（读文件的通道）。
    // 隔离实例的这两类文件在 versions/<id>/ 下，所以用实例实际游戏目录。
    const instanceGameDir = instance ? await instanceGameDirOf(instance) : '';
    const gameDir = path.resolve(instanceGameDir || (currentLaunchEntry()?.gameDir || ''));
    if (!gameDir) throw new Error('无法确定游戏目录，不能导出崩溃信息');

    let crashReport = '';
    if (payload.crashReport) {
      const file = await pathGuard.assertInsideReal(path.join(gameDir, 'crash-reports'), payload.crashReport, '崩溃报告');
      crashReport = await fs.readFile(file, 'utf8').catch(() => '');
    }

    let logText = '';
    if (payload.logFile) {
      const file = await pathGuard.assertInsideReal(path.join(gameDir, 'logs'), payload.logFile, '启动日志');
      logText = (await readTail(file, 2 * 1024 * 1024)).text;
    } else {
      const entry = currentLaunchEntry();
      if (entry && entry.logFile) logText = (await readTail(entry.logFile, 2 * 1024 * 1024)).text;
    }

    if (!crashReport && !logText) throw new Error('没有可导出的崩溃信息');

    const version = instance ? (instance.versionName || instance.id) : 'game';
    const defaultName = safeFileName(`崩溃信息-${version}-${stamp}.txt`) || `crash-${stamp}.txt`;

    const result = await dialog.showSaveDialog(win, {
      title: '导出游戏崩溃信息',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: '文本文件', extensions: ['txt', 'log'] }]
    });
    if (result.canceled || !result.filePath) return null;

    const bundle = [
      'MCDL Launcher · 游戏崩溃信息',
      '==========================',
      '',
      `时间：${new Date().toISOString()}`,
      `实例：${instance ? (instance.displayName || instance.id) : '-'}`,
      `版本：${instance ? (instance.versionName || '-') : '-'}`,
      `崩溃报告：${payload.crashReport || '（无）'}`,
      `启动日志：${payload.logFile || recentLaunches[0]?.logFile || '（无）'}`,
      '',
      '===== 崩溃报告 =====',
      crashReport || '（这次退出没有生成崩溃报告）',
      '',
      '===== 启动日志（尾部） =====',
      logText || '（没有日志）',
      ''
    ].join('\n');

    await writeFileAtomic(result.filePath, bundle, 'utf8');
    await revealPath(result.filePath).catch(() => {});
    return { file: result.filePath, size: Buffer.byteLength(bundle, 'utf8') };
  });

  // ---------------- 启动前完整性闸门 ----------------

  /**
   * 启动上下文：实例 → 基础目录 / 实例目录 / 账号 / 生效设置。
   *
   * 「启动」「预检」「修复」三条路径共用同一份解析逻辑，避免三处各写一遍
   * 之后出现「预检说齐全、启动却报告缺文件」这种自相矛盾。
   */
  async function resolveLaunchContext(payload = {}) {
    const instanceId = payload && typeof payload.instanceId === 'string' ? payload.instanceId : null;

    // 用和实例列表同一套扫描（主目录 + 用户添加的游戏文件夹 + 已缓存的其他启动器），
    // 否则从「添加游戏文件夹」进来的实例会找不到。
    const snapshot = await rescanInstances();
    const instance =
      snapshot.instances.find((item) => item.id === instanceId) ||
      snapshot.instances.find((item) => item.id === snapshot.selectedId);

    if (!instance) throw new Error('没有可启动的实例，请先创建一个实例');

    const versionId = path.basename(instance.path);
    // baseDir：versions / libraries / assets 所在的基础游戏目录；
    // gameDir：游戏真正使用的目录（版本隔离实例 = versions/<id>）。
    const baseDir = instance.gameDir || snapshot.gameDir;
    const gameDir = (await instanceGameDirOf(instance)) || baseDir;
    const settings = await effectiveSettings(instance.path);

    return { instance, versionId, baseDir, gameDir, settings };
  }

  /** 解析账号（含微软令牌刷新）：没有账号就没法构造启动参数，提前失败。 */
  async function resolveLaunchAccount({ refreshTokens = true } = {}) {
    const store = getAccountStore();
    let account = await store.getSelected();
    if (!account) {
      throw new Error('还没有选择账号，请先在「账户」页创建离线账号或登录微软账号');
    }

    if (refreshTokens && account.type === 'microsoft') {
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

    return { store, account };
  }

  async function buildPlanForContext(context, account) {
    return launcher.buildLaunchPlan({
      gameDir: context.baseDir,
      instanceDir: context.gameDir,
      instanceId: context.versionId,
      account,
      settings: context.settings,
      dataDir: app.getPath('userData'),
      resolveJava: (options) => resolveJavaRuntime({ ...options, javaPath: context.settings.javaPath })
    });
  }

  /** 把闸门结果压成 IPC 能传的纯数据（Error 不能过 IPC）。 */
  function serializePreflight(result) {
    return {
      ok: Boolean(result && result.ok),
      checked: result ? result.checked : 0,
      message: result && result.summary ? result.summary.message : '',
      count: result && result.summary ? result.summary.count : 0,
      failures: result && result.summary ? result.summary.failures : [],
      optionalMissing: result && result.optionalMissing ? result.optionalMissing : []
    };
  }

  /**
   * 进行中的启动（还没 spawn 完）：launchId → AbortController。
   * 「取消」要能在规划 / 校验阶段就生效，否则用户点了取消还得等 Java 被拉起来。
   */
  const pendingLaunches = new Map();

  /**
   * 真实启动：按版本 JSON 拼 java 命令并拉起游戏进程。
   *
   * 进度事件只报告真的发生了的事（phase = begin / stage / spawned / output /
   * preflight-failed / exit / error），stage 的每一步都对应引擎里一次实际动作。
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

    const controller = new AbortController();

    try {
      const context = await resolveLaunchContext(payload);
      const { versionId, baseDir, gameDir, settings } = context;

      // 先生成 launchId 并开进度窗口：账号准备 / 文件校验都在 spawn 之前，
      // 用户在任何一个阶段点「取消」都必须能停下来。
      const launchId = crypto.randomUUID();
      pendingLaunches.set(launchId, controller);
      send({ phase: 'begin', launchId, versionId });

      send({ phase: 'stage', stage: 'account', state: 'running' });
      const { store, account } = await resolveLaunchAccount();
      send({
        phase: 'stage',
        stage: 'account',
        state: 'done',
        detail: account.type === 'microsoft'
          ? `微软账号 ${account.name}（令牌已校验）`
          : account.type === 'authlib'
            ? `第三方账号 ${account.name}`
            : `离线账号 ${account.name}`
      });

      let launchContext = null;

      const result = await launcher.launchInstance({
        gameDir: baseDir,
        instanceDir: gameDir,
        instanceId: versionId,
        account,
        settings,
        launchId,
        signal: controller.signal,
        resolveJava: (options) => resolveJavaRuntime({ ...options, javaPath: settings.javaPath }),
        onEvent: (kind, data) => {
          if (kind === 'begin') {
            // 引擎重复发一次 begin（它自己也带 launchId），渲染层按 id 去重，这里只记录。
            pendingLaunches.set(data.launchId, controller);
            send({ phase: 'begin', launchId: data.launchId, versionId });
            return;
          }

          if (kind === 'stage') {
            send({ phase: 'stage', ...data });
            return;
          }

          if (kind === 'output') {
            send({ phase: 'output', stream: data.stream, text: data.text });
            return;
          }

          if (kind === 'spawned') {
            pendingLaunches.delete(data.launchId);
            launchContext = {
              launchId: data.launchId,
              logFile: data.logFile || '',
              gameDir,
              instanceId: context.instance.id,
              versionId,
              javaPath: data.javaPath || '',
              startedAt: Date.now(),
              exited: false
            };
            rememberLaunch(launchContext);
          }

          if (kind === 'exit') {
            pendingLaunches.delete(data.launchId);
            const stopped = stoppedLaunches.has(data.launchId);
            stoppedLaunches.delete(data.launchId);
            const previous = launchContext && launchContext.launchId === data.launchId ? launchContext : null;

            // 崩溃报告 / 日志路径要读盘，不能卡住事件回调，单独异步补一条 exit。
            void (async () => {
              let crashReport = '';
              if (!stopped && Number(data.code) !== 0) {
                crashReport = await findCrashReport(gameDir, previous ? previous.startedAt : 0).catch(() => '');
              }
              // 启动后极短时间内退出、又没留崩溃报告：这是「启动失败」而不是「玩着玩着崩了」，
              // 两者的下一步动作完全不同（去修文件 vs 去删 mod）。
              const earlyFailure = !stopped && Number(data.code) !== 0 && !crashReport &&
                Number(data.uptimeMs) > 0 && Number(data.uptimeMs) < EARLY_FAILURE_MS;

              markLaunchExited(data.launchId, { crashReport, exitCode: data.code, stopped });
              send({
                phase: 'exit',
                ...data,
                stopped,
                earlyFailure,
                logFile: previous ? previous.logFile : '',
                crashReport
              });
            })();
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
      send({ phase: 'error', message: error.message, code: error.code || '' });
      throw error;
    } finally {
      // spawn 成功后这条记录已经删除；失败 / 取消时清掉，避免泄漏 controller。
      for (const [id, pending] of pendingLaunches) {
        if (pending === controller) pendingLaunches.delete(id);
      }
    }
  });

  /**
   * 只做启动前检查，不启动游戏：实例管理页 / 启动失败后都能调。
   */
  ipcMain.handle('launcher:preflight', async (event, payload = {}) => {
    assertAppWindow(event);
    const context = await resolveLaunchContext(payload);
    const { account } = await resolveLaunchAccount({ refreshTokens: false });
    const plan = await buildPlanForContext(context, account);
    const result = await launcher.verifyLaunchPlan(plan, {
      hashCheck: launcher.hashModeFromSettings(context.settings)
    });

    return {
      ...serializePreflight(result),
      instanceId: context.instance.id,
      versionId: context.versionId,
      warnings: plan.warnings,
      unresolvedLibraries: plan.unresolvedLibraries || []
    };
  });

  /**
   * 按闸门的清单重新下载缺失 / 损坏的文件，然后重新校验。
   */
  ipcMain.handle('launcher:repair', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const context = await resolveLaunchContext(payload);
    const { account } = await resolveLaunchAccount({ refreshTokens: false });
    const plan = await buildPlanForContext(context, account);

    const send = (message) => {
      if (!win.isDestroyed()) {
        win.webContents.send('launcher:launch-progress', {
          instanceId: context.instance.id,
          at: Date.now(),
          phase: 'repair-progress',
          message
        });
      }
    };

    const outcome = await launcher.repairLaunchPlan(plan, {
      hashCheck: launcher.hashModeFromSettings(context.settings),
      onProgress: send
    });

    return {
      ok: outcome.ok,
      before: serializePreflight(outcome.before),
      after: serializePreflight(outcome.after),
      repaired: outcome.repair.repaired.map((item) => item.label),
      failed: outcome.repair.failed.map((item) => ({
        label: item.item.label,
        message: item.message
      })),
      skipped: outcome.repair.skipped.map((item) => item.label)
    };
  });

  ipcMain.handle('launcher:stop', async (event, launchId) => {
    assertAppWindow(event);
    const id = String(launchId || '').trim() || (launcher.listActiveLaunches()[0]?.launchId || '');
    // 记下来：手动结束游戏不算崩溃，不要让「游戏崩溃窗口」弹出来。
    if (id) stoppedLaunches.add(id);

    // 还在规划 / 校验阶段：用 AbortController 让引擎在下一个阶段边界停下，
    // 这样根本不会 spawn 出一份 Java 进程。
    const pending = id ? pendingLaunches.get(id) : null;
    if (pending) {
      pending.abort();
      pendingLaunches.delete(id);
      return true;
    }

    return launcher.stopLaunch(id);
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

  // ---------------- 壁纸 ----------------

  /** 列表 + 当前设置一次给全：渲染层只需要一次往返就能画好壁纸。 */
  ipcMain.handle('wallpaper:list', async (event) => {
    assertAppWindow(event);
    const settings = await readSettings();
    return { settings, ...(await listWallpapers(settings)) };
  });

  /**
   * 上传壁纸。
   * 图片复制进 backgrounds（哈希名，重名即命中）；视频只记路径，不复制。
   * 返回更新后的设置与列表，渲染层不用再自己拼一次。
   */
  ipcMain.handle('wallpaper:pick', async (event, payload = {}) => {
    const win = assertAppWindow(event);
    const media = payload && payload.media === 'video' ? 'video' : 'image';

    const result = await dialog.showOpenDialog(win, {
      title: media === 'video' ? '选择壁纸视频' : '选择壁纸图片',
      buttonLabel: '设为壁纸',
      properties: ['openFile'],
      filters: media === 'video'
        ? [{ name: '视频', extensions: ['mp4', 'webm'] }]
        : [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;

    const source = result.filePaths[0];
    const warnings = [];
    let wallFile = '';
    let item = null;

    if (media === 'video') {
      const info = await inspectWallpaperVideo(source);
      wallFile = info.path;
      if (info.size > WALL_VIDEO_WARN_BYTES) {
        warnings.push(
          `这个视频有 ${formatBytes(info.size)}：双解码会多占 60–120 MB 显存，4K 可能掉帧`
        );
      }
      item = {
        kind: 'video',
        label: path.basename(info.path),
        size: info.size,
        width: 0,
        height: 0
      };
    } else {
      const imported = await importWallpaperImage(source);
      wallFile = imported.name;
      if (imported.size > WALL_IMAGE_WARN_BYTES) {
        warnings.push(`这张图有 ${formatBytes(imported.size)}，加载与模糊可能影响流畅度`);
      }
      if (imported.width > WALL_IMAGE_MAX_EDGE || imported.height > WALL_IMAGE_MAX_EDGE) {
        warnings.push(
          `这张图是 ${imported.width}×${imported.height}，超过 8K 会很吃显存`
        );
      }
      item = {
        kind: 'image',
        label: imported.label,
        size: imported.size,
        width: imported.width,
        height: imported.height
      };
    }

    const settings = await writeSettings(
      { wallMode: 'custom', wallMedia: media, wallFile },
      { trustWallFile: true }
    );
    return { settings, ...(await listWallpapers(settings)), item, warnings };
  });

  /** 删除壁纸：图片删文件，视频只清引用（源文件是用户的，不碰）。 */
  ipcMain.handle('wallpaper:remove', async (event, payload = {}) => {
    assertAppWindow(event);
    const current = await readSettings();
    await removeWallpaperEntry(payload, current);

    const removedName = String((payload && payload.name) || '');
    const wasActive = current.wallMedia === 'video'
      ? sameLocalPath(removedName, current.wallFile)
      : removedName === current.wallFile;

    // 删掉正在用的那张 → 回默认样式，不能让设置指向一个不存在的文件。
    const patch = wasActive ? { wallFile: '', wallMode: 'default' } : {};
    const settings = await writeSettings(patch, { trustWallFile: true });
    return { settings, ...(await listWallpapers(settings)) };
  });

  ipcMain.handle('wallpaper:open-folder', async (event) => {
    assertAppWindow(event);
    await openFolderPath(wallpaperRoot());
    return true;
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
  // 窗口可能被重建（macOS 关掉窗口后从 Dock 再打开）：退出状态按窗口代次重置，
  // 否则上一轮收尾留下的 allowQuit / shutdownPromise 会让新窗口「一点关闭就消失」
  // 或者「关了永远不销毁」。
  allowQuit = false;
  shutdownPromise = null;

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

  /**
   * 主文档加载失败：以前只留一行日志，用户看到的是纯白窗口。
   * 现在直接切恢复页（只在主界面失败时切，恢复页自己失败就只记日志，避免死循环）。
   */
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error('[main] renderer failed to load:', errorCode, errorDescription, validatedURL);
    // -3 是我们自己取消的导航（will-navigate 拦截 / 切页），不是加载失败。
    if (errorCode === -3) return;
    if (isMainFrame === false) return;
    if (recoveryPageActive) return;
    if (/recovery\.html/i.test(String(validatedURL || ''))) return;

    loadRecoveryPage('did-fail-load', { errorCode, errorDescription });
  });

  /**
   * 渲染进程崩溃：单次先 reload，短时间内连续 3 次则判定崩溃循环、切静态恢复页。
   * reason === 'oom' 也走同一条路：OOM 后重来一次通常就能恢复。
   */
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const reason = details && details.reason ? details.reason : 'unknown';
    console.error('[main] renderer process gone:', details);
    appLog.append('ERROR', `[renderer-gone] reason=${reason} exitCode=${details && details.exitCode}`);

    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (reason === 'clean-exit') return;

    if (recoveryPageActive) {
      // 恢复页自己也被干掉了：已经无处可退，留日志，让用户用「重置工作区」路径。
      console.error('[recovery] recovery page itself crashed');
      return;
    }

    rendererCrashes.push(Date.now());
    pruneRendererCrashes();

    if (rendererCrashes.length >= RENDERER_CRASH_LOOP) {
      loadRecoveryPage('crash-loop', details);
      return;
    }

    console.warn(`[main] reloading renderer (crash ${rendererCrashes.length}/${RENDERER_CRASH_LOOP} in 60s)`);
    mainWindow.reload();
  });

  /**
   * 卡死（无响应）：给用户一个明确出口，而不是让窗口一直转圈。
   * 这里有超时兜底，用户不点也不会永远挂着。
   */
  mainWindow.on('unresponsive', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    console.error('[main] renderer unresponsive');
    appLog.append('WARN', '[renderer] unresponsive');

    const options = {
      type: 'warning',
      title: '启动器界面无响应',
      message: '启动器界面卡住了。',
      detail: '可以再等一会儿；如果一直没恢复，选择「重新加载界面」即可（不会动游戏与实例数据）。',
      buttons: ['继续等待', '重新加载界面'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    };

    Promise.resolve(dialog.showMessageBox(mainWindow, options))
      .then((result) => {
        if (result && result.response === 1 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.forcefullyCrashRenderer();
        }
      })
      .catch(() => {});
  });

  // 主界面加载成功后只解除「恢复态」；崩溃计数不能在这里清零，
  // 否则「崩溃 → reload 成功 → 再崩溃」永远只算 1 次，崩溃循环永远判定不出来。
  // 计数靠 RENDERER_CRASH_WINDOW_MS 的时间窗自然过期。
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const url = String(mainWindow.webContents.getURL() || '');
    if (/recovery\.html/i.test(url)) return;
    recoveryPageActive = false;
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
    .catch((error) => {
      console.error('[main] loadFile failed:', error);
      loadRecoveryPage('load-failed', { errorDescription: error.message });
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

  /**
   * 关闭窗口：有在飞任务时先取消并等它们收尾（最多 5 秒），再真正销毁。
   *
   * 三条规则：
   *   - allowQuit 已置位（收尾完成）→ 放行，别拦；
   *   - shutdownPromise 已存在（正在等）→ 继续 preventDefault，吞掉重复点击，不重复等；
   *   - 没有在飞任务 → 不拦，行为和以前完全一致（立即关）。
   */
  mainWindow.on('close', (event) => {
    if (allowQuit) return;

    if (shutdownPromise) {
      event.preventDefault();
      return;
    }

    if (inFlightCount() === 0) return;

    event.preventDefault();
    beginShutdown('window:close');
  });

  /**
   * Windows 关机 / 注销：Electron 在 Windows 上不会为此发 before-quit，只会给窗口发 session-end。
   * 系统只留很短的宽限期，拦不住关机；这里能做的是立刻取消任务并尽最大努力等收尾（含写盘），
   * 而不是等窗口被销毁后才 abort。
   */
  mainWindow.on('session-end', () => {
    if (allowQuit || shutdownPromise) return;
    if (inFlightCount() === 0) return;
    console.warn('[shutdown] 系统会话结束（关机/注销），尝试收尾在飞任务');
    beginShutdown('session-end');
  });

  mainWindow.on('closed', () => {
    // 窗口没了就没有人接收进度/取消：把还挂着的 mcdl 子进程与下载一起停掉。
    // 正常路径下任务已经在 beginShutdown 里收尾完毕，这里只兜底极端情况（重复 abort 无害）。
    cancelAllTasks();
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

    // 壁纸目录与协议要在窗口加载前就位：renderer 一启动就会去取 wallpaper:list。
    ensureWallpaperDirs().catch((error) => {
      console.warn('[wallpaper] 无法创建壁纸目录:', error.message);
    });
    registerMediaProtocol();

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

  /**
   * 系统关机 / 任务栏关闭 / app.quit() 等非按钮路径的统一兜底。
   *
   * Electron 的顺序是 before-quit → 关闭窗口（触发 close）→ will-quit。
   * 有在飞任务时先 preventDefault 把退出按住，再走同一套 beginShutdown；
   * 没任务时不拦（保持原来的立即退出）。beginShutdown 结束时 allowQuit 已置位，
   * 它内部补发的 app.quit() 会真正退出，不会死循环。
   */
  app.on('before-quit', (event) => {
    if (allowQuit) return;

    if (shutdownPromise) {
      // close 已经启动收尾，或别处又发了一次退出：等它，别重复。
      event.preventDefault();
      return;
    }

    if (inFlightCount() === 0) return;

    event.preventDefault();
    beginShutdown('before-quit');
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
