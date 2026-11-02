'use strict';

/**
 * 更新通道骨架的测试。
 *
 * 守的几条线：
 *   1. 默认关闭：没有配置时 isConfigured() === false，check() 直接返回，
 *      **连 electron-updater 都不加载**（用会抛错的 loader 证明）；
 *   2. 配置解析：环境变量 > update.json，非法配置一律 null（不会带着半个配置联网）；
 *   3. 版本比较：semver，pre-release 低于正式版，非法字符串安全返回 false；
 *   4. 异常吞掉：check / download / install 都不往外抛，只把状态写成 error；
 *   5. 不自动下载、不静默安装：check 不触发 downloadUpdate，install 只在 downloaded 时生效。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const updater = require('../updater');

// ---------------------------------------------------------------- 版本比较

test('isNewerVersion：基础的语义化版本比较', () => {
  assert.equal(updater.isNewerVersion('1.0.0', '0.2.0'), true);
  assert.equal(updater.isNewerVersion('0.2.0', '1.0.0'), false);
  assert.equal(updater.isNewerVersion('0.2.0', '0.2.0'), false);
  assert.equal(updater.isNewerVersion('0.10.0', '0.9.9'), true);
  assert.equal(updater.isNewerVersion('v0.2.1', '0.2.0'), true);
  assert.equal(updater.isNewerVersion('0.3', '0.2.0'), true);
});

test('isNewerVersion：pre-release 低于同号正式版', () => {
  assert.equal(updater.isNewerVersion('1.0.0-beta.1', '0.2.0'), true);
  assert.equal(updater.isNewerVersion('1.0.0', '1.0.0-beta.1'), true);
  assert.equal(updater.isNewerVersion('1.0.0-beta.2', '1.0.0-beta.1'), true);
  assert.equal(updater.isNewerVersion('1.0.0-beta.10', '1.0.0-beta.2'), true);
  assert.equal(updater.isNewerVersion('1.0.0-alpha', '1.0.0-beta'), false);
  assert.equal(updater.isNewerVersion('1.0.0-beta', '1.0.0-beta.1'), false);
  // build 元数据不参与比较
  assert.equal(updater.isNewerVersion('1.0.0+build.7', '1.0.0'), false);
});

test('isNewerVersion：非法版本字符串安全返回 false，比较函数返回 null', () => {
  for (const bad of ['', 'latest', '1', '1.0.0.0', 'v1.0.0-', '1.0.0-beta..1', null, undefined, 42, {}]) {
    assert.equal(updater.isNewerVersion(bad, '0.2.0'), false, `isNewerVersion(${String(bad)})`);
    assert.equal(updater.isNewerVersion('1.0.0', bad), false, `isNewerVersion(1.0.0, ${String(bad)})`);
    assert.equal(updater.compareVersions(bad, '0.2.0'), null, `compareVersions(${String(bad)})`);
  }
  assert.equal(updater.compareVersions('0.2.0', '0.2.0'), 0);
});

// ---------------------------------------------------------------- 配置解析

test('parseFeedConfig：合法配置补齐默认值', () => {
  const config = updater.parseFeedConfig({ url: 'https://example.com/mcdl/' });
  assert.deepEqual(config, {
    url: 'https://example.com/mcdl',
    channel: 'latest',
    autoCheck: true,
    source: ''
  });
});

test('parseFeedConfig：channel 规范化为小写 token，autoCheck 接受字符串开关', () => {
  const config = updater.parseFeedConfig({
    url: '  https://example.com/updates  ',
    channel: 'BETA',
    autoCheck: 'off'
  });
  assert.equal(config.url, 'https://example.com/updates');
  assert.equal(config.channel, 'beta');
  assert.equal(config.autoCheck, false);

  assert.equal(updater.parseFeedConfig({ url: 'https://a.test', autoCheck: '0' }).autoCheck, false);
  assert.equal(updater.parseFeedConfig({ url: 'https://a.test', autoCheck: false }).autoCheck, false);
  assert.equal(updater.parseFeedConfig({ url: 'https://a.test', autoCheck: true }).autoCheck, true);
});

test('parseFeedConfig：非法 / 空配置一律 null', () => {
  const bad = [
    null,
    undefined,
    '',
    'https://example.com',
    42,
    [],
    {},
    { url: '' },
    { url: '   ' },
    { url: 'ftp://example.com/updates' },
    { url: 'file:///C:/updates' },
    { url: 'mailto:x@example.com' },
    { url: 'not a url' },
    { url: 'https://user:pass@example.com/updates' },
    { url: 'https://example.com', channel: 'bad/channel' },
    { url: 'https://example.com', channel: '..' },
    { url: 'https://example.com', channel: 5 }
  ];

  for (const raw of bad) {
    assert.equal(updater.parseFeedConfig(raw), null, `应被判为非法: ${JSON.stringify(raw)}`);
  }
});

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcdl-updater-'));
}

test('readFeedConfig：没有环境变量和文件时返回 null（默认关闭）', () => {
  const dir = makeTempDir();
  try {
    assert.equal(updater.readFeedConfig({ env: {}, file: path.join(dir, 'update.json') }), null);
    assert.equal(updater.readFeedConfig({ env: {}, file: '' }), null);
    assert.equal(updater.readFeedConfig({ env: {} }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFeedConfig：环境变量优先于 update.json', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'update.json');
  fs.writeFileSync(file, JSON.stringify({ url: 'https://file.example.com/updates' }), 'utf8');

  try {
    const fromEnv = updater.readFeedConfig({
      env: { MCDL_UPDATE_URL: 'https://env.example.com/updates', MCDL_UPDATE_CHANNEL: 'beta' },
      file
    });
    assert.equal(fromEnv.url, 'https://env.example.com/updates');
    assert.equal(fromEnv.channel, 'beta');
    assert.equal(fromEnv.source, 'env');

    const fromFile = updater.readFeedConfig({ env: {}, file });
    assert.equal(fromFile.url, 'https://file.example.com/updates');
    assert.equal(fromFile.source, 'file');

    // 环境变量存在但非法 → null，不偷偷回落到文件（避免「改了环境变量其实没生效」）。
    assert.equal(updater.readFeedConfig({ env: { MCDL_UPDATE_URL: 'http://' }, file }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readFeedConfig：坏 JSON / 不存在的文件 / 非法形状都降级为 null', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'update.json');

  try {
    fs.writeFileSync(file, '{ not json', 'utf8');
    assert.equal(updater.readFeedConfig({ env: {}, file }), null);

    fs.writeFileSync(file, JSON.stringify({ channel: 'latest' }), 'utf8');
    assert.equal(updater.readFeedConfig({ env: {}, file }), null);

    fs.writeFileSync(file, JSON.stringify({ url: 'https://example.com/updates', autoCheck: false }), 'utf8');
    const config = updater.readFeedConfig({ env: {}, file });
    assert.equal(config.url, 'https://example.com/updates');
    assert.equal(config.autoCheck, false);
    assert.equal(config.source, 'file');

    fs.rmSync(file);
    assert.equal(updater.readFeedConfig({ env: {}, file }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 薄封装

function makeFakeUpdater(overrides = {}) {
  const handlers = new Map();
  const calls = {
    checkForUpdates: 0,
    downloadUpdate: 0,
    quitAndInstall: 0,
    quitArgs: null,
    setFeedURL: []
  };

  const fake = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    emit(name, payload) {
      for (const handler of handlers.get(name) || []) handler(payload);
    },
    setFeedURL(options) {
      calls.setFeedURL.push(options);
    },
    async checkForUpdates() {
      calls.checkForUpdates += 1;
      return overrides.checkForUpdates ? overrides.checkForUpdates(fake) : { updateInfo: { version: '0.2.0' } };
    },
    async downloadUpdate() {
      calls.downloadUpdate += 1;
      if (overrides.downloadUpdate) return overrides.downloadUpdate(fake);
      fake.emit('download-progress', { percent: 50, transferred: 50, total: 100, bytesPerSecond: 10 });
      fake.emit('download-progress', { percent: 100, transferred: 100, total: 100, bytesPerSecond: 10 });
      fake.emit('update-downloaded', { version: '1.0.0' });
      return undefined;
    },
    quitAndInstall(isSilent, isForceRunAfter) {
      calls.quitAndInstall += 1;
      calls.quitArgs = [isSilent, isForceRunAfter];
    }
  };

  return { fake, calls };
}

const FEED = { url: 'https://updates.example.com/mcdl', channel: 'latest', autoCheck: true };

/** 未配置时应保持完全惰性：loader 一旦被调用就说明漏了短路。 */
function explodingLoader() {
  throw new Error('未配置更新源时不应加载 electron-updater');
}

test('默认关闭：没有配置时 isConfigured()=false，且不加载任何依赖', async () => {
  let loaded = 0;
  const instance = updater.createUpdater({
    config: null,
    currentVersion: '0.2.0',
    loadDeps: () => {
      loaded += 1;
      return explodingLoader();
    },
    log: () => {}
  });

  assert.equal(instance.isConfigured(), false);
  assert.equal(instance.shouldAutoCheck(), false);
  assert.equal(instance.getState().state, 'not-configured');
  assert.equal(instance.getState().configured, false);

  const checked = await instance.check();
  assert.equal(checked.configured, false);
  assert.equal(checked.state, 'not-configured');
  assert.equal(loaded, 0, '未配置时连依赖 loader 都不能被调用');

  // 下载 / 安装同样是空操作，不抛错、不加载依赖。
  const downloaded = await instance.download();
  assert.equal(downloaded.configured, false);
  const installed = instance.install();
  assert.equal(installed.installing, false);
  assert.equal(loaded, 0);

  // 非法配置视为未配置。
  const broken = updater.createUpdater({ config: { url: 'ftp://x' }, currentVersion: '0.2.0', loadDeps: explodingLoader });
  assert.equal(broken.isConfigured(), false);
});

test('已配置：check 只查不下载，发现新版本后进入 available', async () => {
  const { fake, calls } = makeFakeUpdater({
    checkForUpdates: () => ({ updateInfo: { version: '1.0.0', releaseNotes: '<b>新版本</b>\n修复若干问题' } })
  });
  const sent = [];
  const instance = updater.createUpdater({
    config: FEED,
    currentVersion: '0.2.0',
    loadDeps: () => ({ autoUpdater: fake, appIsPackaged: true }),
    send: (channel, payload) => sent.push({ channel, payload }),
    log: () => {}
  });

  assert.equal(instance.isConfigured(), true);
  assert.equal(instance.shouldAutoCheck(), true);

  const snapshot = await instance.check();
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.version, '1.0.0');
  assert.equal(snapshot.notes, '新版本\n修复若干问题');
  assert.equal(snapshot.channel, 'latest');

  // feed 用的是 generic provider，且 autoDownload 被关掉。
  assert.deepEqual(calls.setFeedURL, [
    { provider: 'generic', url: FEED.url, channel: FEED.channel }
  ]);
  assert.equal(fake.autoDownload, false);
  assert.equal(fake.autoInstallOnAppQuit, false);
  assert.equal(calls.downloadUpdate, 0, 'check 绝不能顺手下载');

  const progressEvents = sent.filter((event) => event.channel === 'updates:progress');
  assert.ok(progressEvents.length >= 2, '检查过程要往渲染层推状态');
  assert.equal(progressEvents[progressEvents.length - 1].payload.state, 'available');
});

test('已配置：远端版本不比当前新时进入 not-available', async () => {
  const { fake } = makeFakeUpdater({ checkForUpdates: () => ({ updateInfo: { version: '0.2.0' } }) });
  const instance = updater.createUpdater({
    config: FEED,
    currentVersion: '0.2.0',
    loadDeps: () => ({ autoUpdater: fake, appIsPackaged: true }),
    send: () => {},
    log: () => {}
  });

  const snapshot = await instance.check();
  assert.equal(snapshot.state, 'not-available');
  assert.equal(snapshot.version, '0.2.0');
});

test('异常吞掉：checkForUpdates 抛错只写状态，不往外抛', async () => {
  const { fake } = makeFakeUpdater({
    checkForUpdates: () => {
      throw new Error('503 Service Unavailable');
    }
  });
  const logs = [];
  const instance = updater.createUpdater({
    config: FEED,
    currentVersion: '0.2.0',
    loadDeps: () => ({ autoUpdater: fake, appIsPackaged: true }),
    send: () => {},
    log: (message) => logs.push(String(message))
  });

  const snapshot = await instance.check();
  assert.equal(snapshot.state, 'error');
  assert.match(snapshot.error, /503/);
  assert.ok(logs.some((line) => line.includes('已忽略')), '失败必须写日志');
});

test('异常吞掉：依赖 loader 抛错 / 没有 autoUpdater 也不会炸出来', async () => {
  const loaders = [
    () => {
      throw new Error('electron-updater 加载失败');
    },
    () => ({})
  ];

  for (const loadDeps of loaders) {
    const instance = updater.createUpdater({
      config: FEED,
      currentVersion: '0.2.0',
      loadDeps,
      send: () => {},
      log: () => {}
    });

    const checked = await instance.check();
    assert.equal(checked.state, 'error');
    assert.ok(checked.error.length > 0);

    const downloaded = await instance.download();
    assert.equal(downloaded.state, 'error');

    // install 在 error 状态下是空操作，不能抛。
    assert.equal(instance.install().installing, false);
  }
});

test('download：进度转发到 updates:progress，完成后进入 downloaded', async () => {
  const { fake, calls } = makeFakeUpdater({
    checkForUpdates: () => ({ updateInfo: { version: '1.0.0' } })
  });
  const sent = [];
  const instance = updater.createUpdater({
    config: FEED,
    currentVersion: '0.2.0',
    loadDeps: () => ({ autoUpdater: fake, appIsPackaged: true }),
    send: (channel, payload) => sent.push({ channel, payload }),
    log: () => {}
  });

  await instance.check();
  const snapshot = await instance.download();

  assert.equal(calls.downloadUpdate, 1);
  assert.equal(snapshot.state, 'downloaded');
  assert.equal(snapshot.progress.percent, 100);

  const percents = sent
    .filter((event) => event.channel === 'updates:progress')
    .map((event) => event.payload.state + ':' + (event.payload.progress ? event.payload.progress.percent : ''))
    .filter((entry) => entry.startsWith('downloading'));
  assert.ok(percents.some((entry) => entry.endsWith(':50')), '中间进度也要转发');
});

test('install：只有 downloaded 状态才真正退出并安装', async () => {
  const { fake, calls } = makeFakeUpdater({
    checkForUpdates: () => ({ updateInfo: { version: '1.0.0' } })
  });
  const instance = updater.createUpdater({
    config: FEED,
    currentVersion: '0.2.0',
    loadDeps: () => ({ autoUpdater: fake, appIsPackaged: true }),
    send: () => {},
    log: () => {}
  });

  await instance.check();
  assert.equal(instance.getState().state, 'available');
  assert.equal(instance.install().installing, false);
  assert.equal(calls.quitAndInstall, 0, '没下载完不能安装');

  await instance.download();
  const installed = instance.install();
  assert.equal(installed.installing, true);
  assert.equal(calls.quitAndInstall, 1);
  assert.deepEqual(calls.quitArgs, [false, true], '走安装向导，装完把启动器拉起来');
});

test('install：quitAndInstall 抛错也被吞掉', async () => {
  const { fake } = makeFakeUpdater({ checkForUpdates: () => ({ updateInfo: { version: '1.0.0' } }) });
  fake.quitAndInstall = () => {
    throw new Error('installer launch failed');
  };

  const instance = updater.createUpdater({
    config: FEED,
    currentVersion: '0.2.0',
    loadDeps: () => ({ autoUpdater: fake, appIsPackaged: true }),
    send: () => {},
    log: () => {}
  });

  await instance.check();
  await instance.download();
  const snapshot = instance.install();
  assert.equal(snapshot.installing, false);
  assert.equal(snapshot.state, 'error');
});

test('download 被取消：退回 available，不算错误', async () => {
  const { fake } = makeFakeUpdater({
    checkForUpdates: () => ({ updateInfo: { version: '1.0.0' } }),
    downloadUpdate: () => {
      const error = new Error('cancelled by user');
      error.name = 'CancellationError';
      throw error;
    }
  });
  const instance = updater.createUpdater({
    config: FEED,
    currentVersion: '0.2.0',
    loadDeps: () => ({ autoUpdater: fake, appIsPackaged: true }),
    send: () => {},
    log: () => {}
  });

  await instance.check();
  const snapshot = await instance.download();
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.error, '');
});

test('autoCheck:false 时启动不检查（shouldAutoCheck=false）', () => {
  const instance = updater.createUpdater({
    config: { ...FEED, autoCheck: false },
    currentVersion: '0.2.0',
    loadDeps: explodingLoader,
    log: () => {}
  });
  assert.equal(instance.isConfigured(), true);
  assert.equal(instance.shouldAutoCheck(), false);
});

test('setFeed：运行时换源，非法配置保持原状', () => {
  const { fake } = makeFakeUpdater();
  const instance = updater.createUpdater({
    config: null,
    currentVersion: '0.2.0',
    loadDeps: () => ({ autoUpdater: fake, appIsPackaged: true }),
    send: () => {},
    log: () => {}
  });

  assert.equal(instance.setFeed('ftp://nope', 'latest'), false);
  assert.equal(instance.isConfigured(), false);

  assert.equal(instance.setFeed('https://updates.example.com/mcdl', 'beta'), true);
  assert.equal(instance.isConfigured(), true);
  assert.equal(instance.getState().channel, 'beta');
});

test('开发态（未打包）不检查：不走网络、状态保持 idle', async () => {
  let checked = 0;
  const { fake } = makeFakeUpdater({
    checkForUpdates: () => {
      checked += 1;
      return { updateInfo: { version: '9.9.9' } };
    }
  });
  const instance = updater.createUpdater({
    config: FEED,
    currentVersion: '0.2.0',
    loadDeps: () => ({ autoUpdater: fake, appIsPackaged: false }),
    send: () => {},
    log: () => {}
  });

  const snapshot = await instance.check();
  assert.equal(snapshot.state, 'idle');
  assert.equal(checked, 0, '未打包时不能真的去查更新');
});

test('快照字段完整：state 只能是约定的几种，progress 结构稳定', async () => {
  const { fake } = makeFakeUpdater({ checkForUpdates: () => ({ updateInfo: { version: '1.0.0' } }) });
  const instance = updater.createUpdater({
    config: FEED,
    currentVersion: '0.2.0',
    loadDeps: () => ({ autoUpdater: fake, appIsPackaged: true }),
    send: () => {},
    log: () => {}
  });

  const snapshot = instance.getState();
  for (const key of ['configured', 'currentVersion', 'state', 'version', 'notes', 'progress']) {
    assert.ok(key in snapshot, `快照缺少 ${key}`);
  }
  assert.ok(updater.UPDATE_STATES.includes(snapshot.state));

  await instance.download();
  const downloaded = instance.getState();
  assert.deepEqual(Object.keys(downloaded.progress).sort(), [
    'bytesPerSecond',
    'percent',
    'total',
    'transferred'
  ]);
});

// ---------------------------------------------------------------- 更新源必须是 https

test('parseFeedConfig：公网明文 http 视为未配置（防中间人同时换包和哈希）', () => {
  for (const bad of [
    'http://example.com/updates',
    'http://cdn.mcdl.example/updates',
    'http://203.0.113.9/updates'
  ]) {
    assert.equal(updater.parseFeedConfig({ url: bad }), null, bad);
  }
});

test('parseFeedConfig：https 正常接受', () => {
  const config = updater.parseFeedConfig({ url: 'https://example.com/updates' });
  assert.ok(config);
  assert.equal(config.url, 'https://example.com/updates');
});

test('parseFeedConfig：明文 http 只放行本机与私有网段（局域网自测要用）', () => {
  for (const okUrl of [
    'http://localhost:8080/dist',
    'http://127.0.0.1:8080',
    'http://[::1]:8080/dist',
    'http://10.1.2.3:8080',
    'http://172.16.5.5/dist',
    'http://172.31.255.254',
    'http://192.168.1.20:8080/dist',
    'http://169.254.10.10'
  ]) {
    const config = updater.parseFeedConfig({ url: okUrl });
    assert.ok(config, `应放行 ${okUrl}`);
    assert.equal(config.url, okUrl.replace(/\/+$/, ''));
  }
});

test('parseFeedConfig：私有网段边界（172.32 / 192.169 / 11.x 都不算私有）', () => {
  for (const bad of ['http://172.32.0.1', 'http://192.169.0.1', 'http://11.0.0.1']) {
    assert.equal(updater.parseFeedConfig({ url: bad }), null, bad);
  }
});
