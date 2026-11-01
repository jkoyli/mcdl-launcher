'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Only the narrow launcher API is exposed to the renderer.
 * ipcRenderer itself is never exposed, so the page stays context-isolated.
 */
const launcherAPI = {
  minimize: () => ipcRenderer.invoke('window:minimize'),

  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),

  close: () => ipcRenderer.invoke('window:close'),

  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  /**
   * 扫描真实游戏目录中的 versions/*，返回：
   *   { gameDir, instances: InstanceData[], selectedId }
   */
  getInstanceInfo: () => ipcRenderer.invoke('instances:list'),

  /**
   * 用户主动扫描其他启动器（PCL/HMCL）实例位置；结果会写入缓存。
   */
  scanOtherInstances: () => ipcRenderer.invoke('instances:scan-other'),

  /**
   * 通过 mcdl 拉取真实正式版列表：[{ id, date }]
   */
  getVersions: () => ipcRenderer.invoke('versions:list'),

  /**
   * 调用 mcdl 安装原版；返回安装后的实例快照。
   */
  createInstance: (payload) => ipcRenderer.invoke('instances:create', payload),

  /**
   * 订阅 mcdl 安装输出。
   */
  onInstallProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('instances:install-progress', (_event, payload) => {
      callback(payload);
    });
  },

  /**
   * 真实启动：主进程按版本 JSON 拼 java 命令并拉起游戏。
   */
  launchGame: (payload) => ipcRenderer.invoke('launcher:launch', payload),

  stopLaunch: (launchId) => ipcRenderer.invoke('launcher:stop', launchId),

  getActiveLaunches: () => ipcRenderer.invoke('launcher:active'),

  /**
   * 启动进度：phase = starting | spawned | output | exit | error
   */
  onLaunchProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('launcher:launch-progress', (_event, payload) => {
      callback(payload);
    });
  },

  // ---------------- 账户 ----------------

  getAccounts: () => ipcRenderer.invoke('accounts:list'),

  addOfflineAccount: (name) => ipcRenderer.invoke('accounts:add-offline', { name }),

  addMicrosoftAccount: () => ipcRenderer.invoke('accounts:add-microsoft'),

  selectAccount: (id) => ipcRenderer.invoke('accounts:select', id),

  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),

  // ---------------- 设置 ----------------

  getSettings: () => ipcRenderer.invoke('settings:get'),

  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  /**
   * L1 标题栏帮助按钮：打开应用日志目录。
   */
  openLogFolder: () => ipcRenderer.invoke('shell:open-logs'),

  /**
   * Optional: keep a custom maximize icon in sync.
   */
  onMaximizedChange: (callback) => {
    if (typeof callback !== 'function') return;

    ipcRenderer.on('window:maximized-changed', (_event, maximized) => {
      callback(Boolean(maximized));
    });
  }
};

contextBridge.exposeInMainWorld('launcherAPI', launcherAPI);
