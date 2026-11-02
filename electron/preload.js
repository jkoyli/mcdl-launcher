'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
   * 某个 Minecraft 版本可用的加载器构建：
   *   { loader, label, gameVersion, versions: [{ version, stable, note }] }
   */
  listLoaders: (payload) => ipcRenderer.invoke('loaders:list', payload),

  /**
   * 实例操作：重命名别名 / 复制 / 删除 / 打开运行目录 / 生成启动脚本。
   */
  renameInstance: (payload) => ipcRenderer.invoke('instances:rename', payload),

  duplicateInstance: (payload) => ipcRenderer.invoke('instances:duplicate', payload),

  removeInstance: (payload) => ipcRenderer.invoke('instances:remove', payload),

  openInstanceFolder: (payload) => ipcRenderer.invoke('instances:open-folder', payload),

  createLaunchScript: (payload) => ipcRenderer.invoke('instances:launch-script', payload),

  /**
   * 游戏目录管理（GameDirectoryPage）。
   */
  getGameDirs: () => ipcRenderer.invoke('gamedirs:list'),

  saveGameDir: (payload) => ipcRenderer.invoke('gamedirs:save', payload),

  removeGameDir: (id) => ipcRenderer.invoke('gamedirs:remove', id),

  /**
   * 实例级设置（覆盖全局的内存 / Java / 窗口 / JVM 参数）。
   */
  getInstanceSettings: (payload) => ipcRenderer.invoke('instances:settings', payload),

  saveInstanceSettings: (payload) => ipcRenderer.invoke('instances:save-settings', payload),

  /**
   * 实例图标：内置图标 / 本地图片 / 清除。
   */
  getInstanceIcon: (payload) => ipcRenderer.invoke('instances:icon-get', payload),

  setInstanceBuiltinIcon: (payload) => ipcRenderer.invoke('instances:icon-set-builtin', payload),

  pickInstanceIcon: (payload) => ipcRenderer.invoke('instances:icon-pick', payload),

  clearInstanceIcon: (payload) => ipcRenderer.invoke('instances:icon-clear', payload),

  /**
   * 内容管理：模组 / 资源包 / 世界 / 原理图。
   */
  listInstanceContent: (payload) => ipcRenderer.invoke('instances:content-list', payload),

  toggleInstanceContent: (payload) => ipcRenderer.invoke('instances:content-toggle', payload),

  deleteInstanceContent: (payload) => ipcRenderer.invoke('instances:content-delete', payload),

  importInstanceContent: (payload) => ipcRenderer.invoke('instances:content-import', payload),

  openInstanceContentFolder: (payload) => ipcRenderer.invoke('instances:content-folder', payload),

  setInstanceContentMany: (payload) => ipcRenderer.invoke('instances:content-set-many', payload),

  deleteInstanceContentMany: (payload) => ipcRenderer.invoke('instances:content-delete-many', payload),

  revealInstanceContent: (payload) => ipcRenderer.invoke('instances:content-reveal', payload),

  pickGameDir: () => ipcRenderer.invoke('gamedirs:pick'),

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
   * 下载中心：版本目录（含最新正式版 / 最新快照）。
   */
  getVersionCatalog: (payload) => ipcRenderer.invoke('downloads:versions', payload || {}),

  /**
   * 下载中心：整合包（本地 .zip / .mrpack）。
   *
   * 三个入口最后都汇聚到同一条管线：pickModpack（对话框）/ prepareModpack（拖拽）
   * 只做预检并返回一次性 token；installModpack 只认 token，不认路径。
   */
  pickModpack: () => ipcRenderer.invoke('downloads:pick-pack'),

  prepareModpack: (file) => ipcRenderer.invoke('downloads:prepare-pack', { file }),

  inspectModpack: (payload) => ipcRenderer.invoke('downloads:inspect-pack', payload),

  installModpack: (payload) => ipcRenderer.invoke('downloads:install-pack', payload),

  /**
   * 拖拽：把 DOM File 换成本机路径（Electron 30+ 必须走 webUtils）。
   * 得到的路径仍然只是"候选"，要经 prepareModpack 预检才能安装。
   */
  pathForFile: (file) => webUtils.getPathForFile(file),

  onDownloadProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('downloads:progress', (_event, payload) => {
      callback(payload);
    });
  },

  /**
   * 下载中心：Modrinth 内容（模组 / 资源包 / 光影）。
   */
  searchAddons: (payload) => ipcRenderer.invoke('downloads:addon-search', payload || {}),

  listAddonVersions: (payload) => ipcRenderer.invoke('downloads:addon-versions', payload || {}),

  installAddon: (payload) => ipcRenderer.invoke('downloads:install-addon', payload || {}),

  saveAddon: (payload) => ipcRenderer.invoke('downloads:save-addon', payload || {}),

  onAddonProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('downloads:addon-progress', (_event, payload) => {
      callback(payload);
    });
  },

  /**
   * 世界（存档）：列表 / level.dat 读写 / 导出 / 备份 / 数据包。
   */
  listWorlds: (payload) => ipcRenderer.invoke('worlds:list', payload || {}),

  getWorldInfo: (payload) => ipcRenderer.invoke('worlds:info', payload || {}),

  saveWorldInfo: (payload) => ipcRenderer.invoke('worlds:save-info', payload || {}),

  deleteWorld: (payload) => ipcRenderer.invoke('worlds:delete', payload || {}),

  duplicateWorld: (payload) => ipcRenderer.invoke('worlds:duplicate', payload || {}),

  exportWorld: (payload) => ipcRenderer.invoke('worlds:export', payload || {}),

  openWorldFolder: (payload) => ipcRenderer.invoke('worlds:open-folder', payload || {}),

  listWorldBackups: (payload) => ipcRenderer.invoke('worlds:backups', payload || {}),

  createWorldBackup: (payload) => ipcRenderer.invoke('worlds:backup-create', payload || {}),

  restoreWorldBackup: (payload) => ipcRenderer.invoke('worlds:backup-restore', payload || {}),

  deleteWorldBackup: (payload) => ipcRenderer.invoke('worlds:backup-delete', payload || {}),

  openWorldBackupFolder: (payload) => ipcRenderer.invoke('worlds:open-backup-folder', payload || {}),

  listDatapacks: (payload) => ipcRenderer.invoke('worlds:datapacks', payload || {}),

  importDatapack: (payload) => ipcRenderer.invoke('worlds:import-datapack', payload || {}),

  deleteDatapack: (payload) => ipcRenderer.invoke('worlds:delete-datapack', payload || {}),

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

  /**
   * 第三方认证服务器（authlib-injector）。
   */
  getAuthServers: () => ipcRenderer.invoke('accounts:servers'),

  addAuthServer: (apiRoot) => ipcRenderer.invoke('accounts:add-server', { apiRoot }),

  removeAuthServer: (id) => ipcRenderer.invoke('accounts:remove-server', id),

  loginAuthlib: (payload) => ipcRenderer.invoke('accounts:login-authlib', payload),

  /**
   * 离线皮肤：选文件 / 保存 / 只改模型 / 清除 / 读取预览。
   */
  pickSkinFile: () => ipcRenderer.invoke('accounts:pick-skin'),

  applySkin: (payload) => ipcRenderer.invoke('accounts:set-skin', payload),

  setSkinModel: (payload) => ipcRenderer.invoke('accounts:set-skin-model', payload),

  clearSkin: (id) => ipcRenderer.invoke('accounts:clear-skin', id),

  getSkinData: (id) => ipcRenderer.invoke('accounts:skin-data', id),

  /**
   * 重新拉取微软 / 认证服务器的皮肤（玩家换了皮肤后用）。
   */
  refreshSkin: (id) => ipcRenderer.invoke('accounts:refresh-skin', id),

  // ---------------- 设置 ----------------

  getSettings: () => ipcRenderer.invoke('settings:get'),

  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  /**
   * 自定义 Java：只能通过系统对话框选择。主进程会验证它真是 JVM 并登记指纹，
   * 返回 { path, info, identity } 或 null（取消）。
   */
  pickJava: () => ipcRenderer.invoke('settings:pick-java'),

  /** 启动时读偏好（不触发 Java 扫描）。 */
  getPreferences: () => ipcRenderer.invoke('settings:preferences'),

  /**
   * 关于页：版本、Electron / Node、数据目录、仓库地址。
   */
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  /**
   * 渲染模式：{ mode: 'gpu'|'software', software, gpuFeatureStatus, crashMarker }
   * 软件渲染时渲染进程会启用降级样式。
   */
  getRenderMode: () => ipcRenderer.invoke('env:render-mode'),

  /**
   * L1 标题栏帮助按钮：打开应用日志目录。
   */
  openLogFolder: () => ipcRenderer.invoke('shell:open-logs'),

  /**
   * 整进程重启（改了主进程代码后用，标题栏「刷新」按住 Shift）。
   */
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),

  /**
   * 弹窗里的「可点击面板」：在系统浏览器打开 http(s) 页面。
   */
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

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
