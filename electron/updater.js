'use strict';

/**
 * 更新通道骨架（electron-updater generic provider）。
 *
 * 设计原则：**可配置但默认关闭**。
 *   - 没有配置（环境变量 MCDL_UPDATE_URL / <userData>/update.json 都没有）时，
 *     本模块不 require electron-updater、不 require electron、不发起任何网络请求，
 *     `isConfigured()` 返回 false，`check()` 直接返回快照。
 *   - 配置合法时才走 electron-updater；它挂在什么地址、什么时候检查都由配置决定。
 *   - 所有异常一律吞掉并写日志：更新服务挂掉不能影响启动器本身。
 *   - 不自动下载、不静默安装：autoDownload = false，autoInstallOnAppQuit = false，
 *     install() 只在用户已经点过「下载」且状态为 downloaded 时才真正退出并安装。
 *
 * 分层：
 *   1. 纯逻辑（parseFeedConfig / compareVersions / isNewerVersion / readFeedConfig）：
 *      只依赖 node:fs 与全局 URL，可以被 node:test 直接 require，**不 require electron**。
 *   2. createUpdater()：薄封装。electron-updater / electron 通过 loadDeps 注入并延迟加载，
 *      默认实现是 loadDefaultDeps；测试可以注入假的 autoUpdater 或干脆注入一个会抛错的
 *      loader 来证明「未配置时根本不会加载依赖」。
 *
 * 配置形状（update.json）：
 *   { "url": "https://example.com/mcdl/updates/", "channel": "latest", "autoCheck": true }
 *   - url       必填；generic provider 的根地址。必须是 https（明文 http 只放行
 *               本机 / 私有网段，用于局域网自测；公网 http 会被当成未配置）。
 *   - channel   可选，默认 "latest"；只允许字母数字与 . _ -（会拼进 latest.yml 文件名）。
 *   - autoCheck 可选，默认 true；显式 false（或 "0"/"false"/"off"/"no"）时启动不检查。
 */

const fs = require('node:fs');

const DEFAULT_CHANNEL = 'latest';
const MAX_URL_LENGTH = 2048;
const MAX_NOTES_LENGTH = 4000;
const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const UPDATE_STATES = [
  'not-configured', // 没有更新源：默认状态，任何动作都是空操作
  'idle', // 已配置但没有检查过
  'checking',
  'not-available',
  'available',
  'downloading',
  'downloaded',
  'error'
];

// ---------------------------------------------------------------- 纯逻辑：版本

/**
 * 解析语义化版本（宽松版）：允许前缀 v、允许省略 patch、允许 pre-release / build 元数据。
 * 解析不出来返回 null —— 调用方必须把 null 当成「不知道」，不能当成「更新」。
 */
function parseVersion(raw) {
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (!text || text.length > 128) return null;

  const matched =
    /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(text);
  if (!matched) return null;

  const core = [
    Number(matched[1]),
    Number(matched[2]),
    matched[3] === undefined ? 0 : Number(matched[3])
  ];
  if (!core.every((part) => Number.isSafeInteger(part) && part >= 0)) return null;

  const prerelease = matched[4] ? matched[4].split('.') : [];
  // 空标识符（"1.0.0-beta..1"）不是合法 semver。
  if (prerelease.some((part) => part === '')) return null;

  return {
    core,
    prerelease: prerelease.map((part) => (/^\d+$/.test(part) ? { numeric: Number(part) } : { text: part }))
  };
}

/** 按 semver 规则比较 pre-release 标识符；返回 -1 / 0 / 1。 */
function comparePrerelease(a, b) {
  if (!a.length && !b.length) return 0;
  // 有 pre-release 的版本低于正式版：1.0.0-beta.1 < 1.0.0
  if (!a.length) return 1;
  if (!b.length) return -1;

  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];

    if (!left) return -1; // 前缀更短更低
    if (!right) return 1;

    if (left.numeric !== undefined && right.numeric !== undefined) {
      if (left.numeric !== right.numeric) return left.numeric < right.numeric ? -1 : 1;
      continue;
    }
    // 数字标识符低于字母标识符
    if (left.numeric !== undefined && right.numeric === undefined) return -1;
    if (left.numeric === undefined && right.numeric !== undefined) return 1;
    if (left.text !== right.text) return left.text < right.text ? -1 : 1;
  }

  return 0;
}

/**
 * 语义化版本比较。任一版本非法时返回 null（调用方自行决定失败语义）。
 *   compareVersions('1.0.0', '0.2.0')      → 1
 *   compareVersions('1.0.0-beta.1', '1.0.0') → -1
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * a 是否比 b 新。任一版本非法 → false。
 *
 * 这里刻意把「不知道」当成「不更新」：远端返回一个解析不了的版本号时，
 * 宁可漏掉一次更新，也不要在 UI 上谎报「发现新版本」。
 */
function isNewerVersion(a, b) {
  return compareVersions(a, b) === 1;
}

// ---------------------------------------------------------------- 纯逻辑：配置

// 纯 HTTP 的更新源等于把「下发什么安装包」的权力交给中间人：latest.yml 与安装包
// 可以一起被换掉，哈希校验也没意义。所以默认只接受 https。
// 唯一例外是本机 / 私有网段（局域网自测 `npx http-server ./dist` 的场景），
// 这些地址不经过公网，MITM 面很小。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // 10.0.0.0/8 · 172.16.0.0/12 · 192.168.0.0/16 · 169.254.0.0/16
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const m172 = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

function normalizeFeedUrl(raw) {
  if (typeof raw !== 'string') return '';

  const text = raw.trim();
  if (!text || text.length > MAX_URL_LENGTH) return '';

  let parsed = null;
  try {
    parsed = new URL(text);
  } catch {
    return '';
  }

  // generic provider 只支持 http / https；file:// 之类一律视为非法（不静默降级成本地路径）。
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (!parsed.hostname) return '';
  if (parsed.username || parsed.password) return '';

  // 明文 http 只允许本机 / 私有网段，公网一律拒绝（返回 '' = 视为未配置）。
  if (parsed.protocol === 'http:' && !isPrivateHost(parsed.hostname)) return '';

  // 用 href（已做百分号编码与主机名规范化）而不是原始字符串，免得配置里的空格 /
  // 中文路径把 electron-updater 拼出来的 URL 弄坏。
  // 去掉末尾斜杠：electron-updater 自己会拼 `/<channel>.yml`，留着会变成 `//latest.yml`。
  return parsed.href.replace(/\/+$/, '');
}

function normalizeChannel(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CHANNEL;
  if (typeof raw !== 'string') return null;

  const channel = raw.trim().toLowerCase();
  if (!CHANNEL_PATTERN.test(channel)) return null;
  return channel;
}

function normalizeAutoCheck(raw) {
  if (raw === undefined || raw === null || raw === '') return true;
  if (typeof raw === 'boolean') return raw;

  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    return true;
  }

  return Boolean(raw);
}

/**
 * 规范化更新源配置：合法 → { url, channel, autoCheck, source }；非法 / 空 → null。
 * 纯函数，不读磁盘、不读环境变量，方便直接测。
 */
function parseFeedConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const url = normalizeFeedUrl(raw.url);
  if (!url) return null;

  const channel = normalizeChannel(raw.channel);
  if (!channel) return null;

  return {
    url,
    channel,
    autoCheck: normalizeAutoCheck(raw.autoCheck),
    source: typeof raw.source === 'string' ? raw.source : ''
  };
}

/**
 * 读配置：优先环境变量 MCDL_UPDATE_URL，其次 <userData>/update.json。
 *
 *   readFeedConfig({ env, file })
 *     env  默认 process.env；file 是 update.json 的绝对路径。
 *
 * 规则：
 *   - 环境变量存在但非法 → null（不偷偷回落到文件，避免「以为改了环境变量其实没生效」）；
 *   - 文件缺失 / JSON 坏掉 / 形状不对 → null（默认关闭）；
 *   - 环境变量里可选的 MCDL_UPDATE_CHANNEL / MCDL_UPDATE_AUTOCHECK 覆盖对应字段。
 */
function readFeedConfig(options = {}) {
  const env = options && typeof options.env === 'object' && options.env ? options.env : process.env;
  const file = options && typeof options.file === 'string' ? options.file : '';

  const envUrl = env && typeof env.MCDL_UPDATE_URL === 'string' ? env.MCDL_UPDATE_URL.trim() : '';
  if (envUrl) {
    const parsed = parseFeedConfig({
      url: envUrl,
      channel: env.MCDL_UPDATE_CHANNEL,
      autoCheck: env.MCDL_UPDATE_AUTOCHECK,
      source: 'env'
    });
    return parsed ? { ...parsed, source: 'env' } : null;
  }

  if (!file) return null;

  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // 没有这个文件就是最常见的「未配置」，不是错误。
    return null;
  }

  let json = null;
  try {
    json = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }

  const parsed = parseFeedConfig(json);
  return parsed ? { ...parsed, source: 'file' } : null;
}

// ---------------------------------------------------------------- 薄封装

function describeError(error) {
  if (!error) return '未知错误';
  const text = typeof error === 'string' ? error : error.message || String(error);
  return String(text).slice(0, 500);
}

function normalizeNotes(raw) {
  if (raw === undefined || raw === null) return '';

  if (typeof raw === 'string') {
    return raw.replace(/<[^>]*>/g, '').trim().slice(0, MAX_NOTES_LENGTH);
  }

  if (Array.isArray(raw)) {
    const parts = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const note = typeof entry.note === 'string' ? entry.note : '';
      if (!note) continue;
      parts.push(note.replace(/<[^>]*>/g, '').trim());
    }
    return parts.join('\n').trim().slice(0, MAX_NOTES_LENGTH);
  }

  return '';
}

function sanitizeProgress(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  const percent = Math.max(0, Math.min(100, number(source.percent)));

  return {
    percent: Math.round(percent * 100) / 100,
    transferred: Math.max(0, number(source.transferred)),
    total: Math.max(0, number(source.total)),
    bytesPerSecond: Math.max(0, number(source.bytesPerSecond))
  };
}

/**
 * 默认依赖装载：**只在真正要用的时候**才 require。
 *
 * 未配置更新源时这条路径根本不会执行，所以「默认关闭」不仅是不发请求，
 * 连 electron-updater / electron 这两个模块都不会被加载。
 */
function loadDefaultDeps() {
  const { autoUpdater } = require('electron-updater');

  let appIsPackaged;
  try {
    appIsPackaged = require('electron').app.isPackaged;
  } catch {
    // 单测 / 非 Electron 环境：拿不到就当成「未知」，由调用方继续。
    appIsPackaged = undefined;
  }

  return { autoUpdater, appIsPackaged };
}

/**
 * 创建更新器实例。
 *
 * options:
 *   config          parseFeedConfig / readFeedConfig 的结果，null 表示未配置
 *   currentVersion  当前启动器版本（main.js 传 app.getVersion()）
 *   send(channel, payload)  转发事件给渲染层（可选）
 *   log(message, error)     写日志（可选）
 *   loadDeps()              { autoUpdater, appIsPackaged }，默认 loadDefaultDeps（测试可注入）
 *   state                   初始状态（默认 idle / not-configured）
 */
function createUpdater(options = {}) {
  const opts = options || {};

  const currentVersion =
    typeof opts.currentVersion === 'string' ? opts.currentVersion : String(opts.currentVersion || '');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const send = typeof opts.send === 'function' ? opts.send : () => {};
  const loadDeps = typeof opts.loadDeps === 'function' ? opts.loadDeps : loadDefaultDeps;

  let config = opts.config ? parseFeedConfig(opts.config) : null;
  let state = config ? 'idle' : 'not-configured';
  let version = '';
  let notes = '';
  let progress = null;
  let errorMessage = '';

  let deps = null;
  let bound = false;
  let pendingCheck = null;
  let pendingDownload = null;
  let installing = false;

  function configured() {
    return Boolean(config);
  }

  function snapshot() {
    return {
      configured: configured(),
      currentVersion,
      state,
      version,
      notes,
      progress: progress ? { ...progress } : null,
      channel: config ? config.channel : '',
      error: errorMessage,
      installing
    };
  }

  function publish() {
    try {
      send('updates:progress', snapshot());
    } catch (error) {
      log('[updater] 无法把更新状态转发给渲染层:', error);
    }
  }

  function fail(error) {
    state = 'error';
    errorMessage = describeError(error);
    progress = null;
    log('[updater] 更新操作失败（已忽略，不影响启动器）:', error);
    publish();
  }

  function applyInfo(info) {
    if (!info || typeof info !== 'object') return;
    if (info.version !== undefined && info.version !== null) version = String(info.version);
    const text = normalizeNotes(info.releaseNotes);
    if (text) notes = text;
  }

  function bindEvents(autoUpdater) {
    if (bound) return;
    bound = true;

    const on = (name, handler) => {
      try {
        autoUpdater.on(name, handler);
      } catch (error) {
        log(`[updater] 无法订阅 ${name}:`, error);
      }
    };

    on('checking-for-update', () => {
      state = 'checking';
      errorMessage = '';
      publish();
    });

    on('update-available', (info) => {
      applyInfo(info);
      state = 'available';
      progress = null;
      publish();
    });

    on('update-not-available', (info) => {
      applyInfo(info);
      state = 'not-available';
      progress = null;
      publish();
    });

    on('download-progress', (payload) => {
      state = 'downloading';
      progress = sanitizeProgress(payload);
      publish();
    });

    on('update-downloaded', (info) => {
      applyInfo(info);
      state = 'downloaded';
      if (!progress) progress = sanitizeProgress({ percent: 100 });
      else progress = { ...progress, percent: 100 };
      publish();
    });

    on('error', (error) => {
      fail(error);
    });
  }

  function applyFeed(autoUpdater) {
    if (!config || !autoUpdater) return;
    try {
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: config.url,
        channel: config.channel
      });
    } catch (error) {
      // 配置本身已经校验过，这里出错只可能是 electron-updater 内部状态问题；
      // 记一笔，后面的 checkForUpdates 会给出真正的结论。
      log('[updater] setFeedURL 失败:', error);
    }
  }

  function ensureDeps() {
    if (deps) return deps;

    const loaded = loadDeps() || {};
    if (!loaded.autoUpdater) throw new Error('electron-updater 不可用');

    deps = loaded;

    try {
      deps.autoUpdater.autoDownload = false;
    } catch (error) {
      log('[updater] 无法关闭 autoDownload:', error);
    }
    try {
      // 默认 true 会在退出时偷偷安装，和「不静默安装」冲突。
      deps.autoUpdater.autoInstallOnAppQuit = false;
    } catch (error) {
      log('[updater] 无法关闭 autoInstallOnAppQuit:', error);
    }

    bindEvents(deps.autoUpdater);
    applyFeed(deps.autoUpdater);
    return deps;
  }

  /** 启动时是否该做一次静默检查：必须已配置，且 update.json 没写 autoCheck: false。 */
  function shouldAutoCheck() {
    return configured() && config.autoCheck !== false;
  }

  /** 没有配置 → false。这是「默认关闭」的对外唯一判据。 */
  function isConfigured() {
    return configured();
  }

  /** 换更新源（运行时设置用）。非法配置返回 false 并保持原状。 */
  function setFeed(url, channel) {
    const parsed = parseFeedConfig({ url, channel });
    if (!parsed) {
      log('[updater] 更新源配置非法，保持原有配置不变');
      return false;
    }

    config = parsed;
    state = 'idle';
    version = '';
    notes = '';
    progress = null;
    errorMessage = '';
    installing = false;

    if (deps) applyFeed(deps.autoUpdater);
    return true;
  }

  /** 启动日志：说清楚「开着还是关着、为什么」。 */
  function init() {
    if (config) {
      log(
        `[updater] 更新源已配置（${config.source || 'config'}）：` +
          `${config.url} channel=${config.channel} autoCheck=${config.autoCheck !== false}`
      );
    } else {
      log('[updater] 未配置更新源：更新通道关闭（不检查、不联网）');
    }
    return snapshot();
  }

  /** 只查不下载。未配置时直接返回，不加载依赖、不联网、不抛错。 */
  async function check() {
    if (!config) {
      state = 'not-configured';
      log('[updater] 未配置更新源，跳过更新检查');
      return snapshot();
    }

    if (pendingCheck) return pendingCheck;

    pendingCheck = (async () => {
      try {
        const loaded = ensureDeps();

        // 未打包（开发态）时 electron-updater 自己也会拒绝检查；这里提前退出，
        // 免得开发日志里刷一堆 "Skip checkForUpdates because application is not packed"。
        if (loaded && loaded.appIsPackaged === false) {
          state = 'idle';
          log('[updater] 开发模式（未打包）不检查更新');
          return snapshot();
        }

        state = 'checking';
        errorMessage = '';
        publish();

        const result = await loaded.autoUpdater.checkForUpdates();
        const info = result && result.updateInfo ? result.updateInfo : null;

        if (info && info.version !== undefined && info.version !== null) {
          applyInfo(info);
          // 事件回调与返回值都可信，以版本比较为准，避免事件丢失时状态卡在 checking。
          if (isNewerVersion(version, currentVersion)) {
            state = 'available';
          } else {
            state = 'not-available';
          }
        } else if (state === 'checking') {
          // 开发态 / 被 provider 忽略：既不是「有更新」也不是「已是最新」。
          state = 'idle';
        }

        publish();
        return snapshot();
      } catch (error) {
        fail(error);
        return snapshot();
      } finally {
        pendingCheck = null;
      }
    })();

    return pendingCheck;
  }

  /** 用户点了「下载并安装」才调用；绝不自动触发。 */
  async function download() {
    if (!config) {
      state = 'not-configured';
      log('[updater] 未配置更新源，忽略下载请求');
      return snapshot();
    }

    if (pendingDownload) return pendingDownload;

    pendingDownload = (async () => {
      try {
        const loaded = ensureDeps();
        if (loaded && loaded.appIsPackaged === false) {
          log('[updater] 开发模式（未打包）不下载更新');
          return snapshot();
        }

        state = 'downloading';
        progress = sanitizeProgress({ percent: 0 });
        errorMessage = '';
        publish();

        await loaded.autoUpdater.downloadUpdate();

        // 事件兜底：downloadUpdate 正常返回意味着已经下载完。
        if (state !== 'downloaded') {
          state = 'downloaded';
          progress = sanitizeProgress({ percent: 100 });
          publish();
        }
        return snapshot();
      } catch (error) {
        // 用户取消不算错误，退回「可下载」状态即可。
        if (error && (error.name === 'CancellationError' || error.code === 'ERR_UPDATER_CANCELLED')) {
          state = 'available';
          progress = null;
          log('[updater] 下载已取消');
          publish();
          return snapshot();
        }
        fail(error);
        return snapshot();
      } finally {
        pendingDownload = null;
      }
    })();

    return pendingDownload;
  }

  /** 只在已经下载完成时退出并安装；其它情况是空操作（不静默安装）。 */
  function install() {
    if (!config) {
      log('[updater] 未配置更新源，忽略安装请求');
      return snapshot();
    }

    if (state !== 'downloaded') {
      log('[updater] 更新尚未下载完成，忽略安装请求');
      return snapshot();
    }

    try {
      const loaded = ensureDeps();
      log('[updater] 退出并安装更新');
      installing = true;
      publish();
      // isSilent=false：走正常安装向导；isForceRunAfter=true：装完把启动器拉起来。
      loaded.autoUpdater.quitAndInstall(false, true);
      return snapshot();
    } catch (error) {
      installing = false;
      fail(error);
      return snapshot();
    }
  }

  return {
    init,
    isConfigured,
    shouldAutoCheck,
    setFeed,
    check,
    download,
    install,
    getState: snapshot,
    states: UPDATE_STATES.slice()
  };
}

module.exports = {
  parseVersion,
  compareVersions,
  isNewerVersion,
  parseFeedConfig,
  readFeedConfig,
  createUpdater,
  sanitizeProgress,
  normalizeNotes,
  DEFAULT_CHANNEL,
  UPDATE_STATES
};
