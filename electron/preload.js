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
   * 扫描缓存（<userData>/scanned-game-dirs.json）：{ dirs: string[], updatedAt: string|null }
   */
  getScanCache: () => ipcRenderer.invoke('instances:scan-cache'),

  /**
   * 清空扫描缓存，返回 { removed }（清掉了几条）。只清记录，不动游戏文件。
   */
  clearScanCache: () => ipcRenderer.invoke('instances:scan-cache-clear'),

  /**
   * 只把一个目录从扫描缓存里剔除，返回 { removed, remaining }。
   */
  forgetScanCacheDir: (dir) => ipcRenderer.invoke('instances:scan-cache-forget', dir),

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

  /**
   * 启动前完整性闸门：只检查、不启动。
   *   → { ok, checked, message, count, failures:[{label, relative, reason, description, url}], warnings }
   * 失败时 failures 就是「缺什么」，可以直接逐条展示。
   */
  checkLaunchFiles: (payload) => ipcRenderer.invoke('launcher:preflight', payload || {}),

  /**
   * 按闸门清单重新下载缺失 / 损坏的文件，然后重新校验。
   *   → { ok, before, after, repaired:[label], failed:[{label,message}], skipped:[label] }
   */
  repairLaunchFiles: (payload) => ipcRenderer.invoke('launcher:repair', payload || {}),

  stopLaunch: (launchId) => ipcRenderer.invoke('launcher:stop', launchId),

  getActiveLaunches: () => ipcRenderer.invoke('launcher:active'),

  /**
   * 启动进度：phase = starting | spawned | output | exit | error
   * exit 事件带上 stopped / logFile / crashReport，游戏崩溃窗口用它。
   */
  onLaunchProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('launcher:launch-progress', (_event, payload) => {
      callback(payload);
    });
  },

  /**
   * 日志窗口：打开时读一次快照，之后靠 onLaunchProgress 的 output 事件续上。
   *   snapshot → { file, text, truncated, active, launch, appLogFile, appLogDir }
   */
  getLogSnapshot: (payload) => ipcRenderer.invoke('logs:tail', payload || {}),

  exportLog: (payload) => ipcRenderer.invoke('logs:export', payload || {}),

  openLogFolder: (scope) => ipcRenderer.invoke('logs:open-folder', { scope: scope === 'game' ? 'game' : 'app' }),

  openGameLogFolder: (payload) => ipcRenderer.invoke('logs:open-folder', { ...(payload || {}), scope: 'game' }),

  exportThreadDump: (payload) => ipcRenderer.invoke('logs:dump', payload || {}),

  exportCrashInfo: (payload) => ipcRenderer.invoke('crash:export', payload || {}),

  /** 系统剪贴板写入（渲染层读不到 file:// 下的 navigator.clipboard 时用）。 */
  copyText: (text) => ipcRenderer.invoke('ui:copy-text', { text }),

  /** 启动器自身崩溃：主进程 console.error / uncaughtException 时推送。 */
  onLauncherCrash: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('launcher:crash', (_event, payload) => {
      callback(payload);
    });
  },

  /**
   * 实例详情：截图（列表带 data URL）、复制到剪贴板、设为启动器背景。
   */
  listScreenshots: (payload) => ipcRenderer.invoke('instances:screenshots', payload || {}),

  copyScreenshot: (payload) => ipcRenderer.invoke('screenshots:copy', payload || {}),

  setScreenshotWallpaper: (payload) => ipcRenderer.invoke('screenshots:set-wallpaper', payload || {}),

  /**
   * 实例详情：管理菜单的维护动作。
   *   action = clean | remove-assets | remove-libraries | redownload-assets
   */
  runInstanceMaintenance: (payload) => ipcRenderer.invoke('instances:maintenance', payload || {}),

  /** 更新整合包：把新包装出来的临时实例合并进目标实例。 */
  mergeModpack: (payload) => ipcRenderer.invoke('instances:merge-pack', payload || {}),

  /** 更新整合包的进度（备份 / 复制 / 替换目录）。 */
  onMergeProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('instances:merge-progress', (_event, payload) => {
      callback(payload);
    });
  },

  /** 撤销上一次更新整合包：按备份还原被覆盖的文件、删除本次新增的文件。 */
  undoMergeModpack: (payload) => ipcRenderer.invoke('instances:merge-undo', payload || {}),

  /**
   * 导出整合包：扫描 → 向导 → 打包。
   *   scan   → { categories, name, versionName, loader, … }
   *   export → { file, size, fileCount, format }
   */
  scanModpack: (payload) => ipcRenderer.invoke('modpack:scan', payload || {}),

  exportModpack: (payload) => ipcRenderer.invoke('modpack:export', payload || {}),

  onModpackExportProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('modpack:export-progress', (_event, payload) => {
      callback(payload);
    });
  },

  /** 设置 → Java 管理：从 Adoptium 下载并安装一个 JDK。 */
  installJava: (payload) => ipcRenderer.invoke('java:install', payload || {}),

  onJavaInstallProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('java:install-progress', (_event, payload) => {
      callback(payload);
    });
  },

  /** 设置 → 通用 → NBT 编辑器：选文件得到一次性 token，保存只认 token。 */
  pickNbtFile: () => ipcRenderer.invoke('nbt:pick'),

  saveNbtEdits: (payload) => ipcRenderer.invoke('nbt:save', payload || {}),

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
   * 壁纸（L1）：
   *   list()        → { settings, items, root, missing }
   *   pick(media)   → { settings, items, missing, item, warnings } 或 null（取消）
   *   remove(item)  → { settings, items, missing }
   * 媒体本身走 mcdl-media:// 协议，这里只传列表与设置。
   */
  listWallpapers: () => ipcRenderer.invoke('wallpaper:list'),

  pickWallpaper: (media) => ipcRenderer.invoke('wallpaper:pick', { media: media === 'video' ? 'video' : 'image' }),

  removeWallpaper: (payload) => ipcRenderer.invoke('wallpaper:remove', payload || {}),

  openWallpaperFolder: () => ipcRenderer.invoke('wallpaper:open-folder'),

  /**
   * 关于页：版本、Electron / Node、数据目录、仓库地址。
   */
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  /**
   * 更新通道（默认关闭）。未配置更新源时 getUpdateState() 返回 configured:false，
   * 四个动作都不报错、不联网。
   *
   *   getUpdateState()   → { configured, currentVersion, state, version, notes, progress }
   *   checkUpdates()     → 只查不下载
   *   downloadUpdate()   → 用户点了才下载
   *   installUpdate()    → 已下载完成时退出并安装
   */
  getUpdateState: () => ipcRenderer.invoke('updates:state'),

  checkUpdates: () => ipcRenderer.invoke('updates:check'),

  downloadUpdate: () => ipcRenderer.invoke('updates:download'),

  installUpdate: () => ipcRenderer.invoke('updates:install'),

  /** 下载进度 / 状态变化（payload 与 getUpdateState() 同形状）。 */
  onUpdateProgress: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('updates:progress', (_event, payload) => {
      callback(payload);
    });
  },

  /**
   * 渲染模式：{ mode: 'gpu'|'software', software, gpuFeatureStatus, crashMarker }
   * 软件渲染时渲染进程会启用降级样式。
   */
  getRenderMode: () => ipcRenderer.invoke('env:render-mode'),

  /**
   * 整进程重启（改了主进程代码后用，标题栏「刷新」按住 Shift）。
   */
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),

  /**
   * 本地音乐播放器（右上角圆钮）。
   *
   * 播放列表只能通过原生对话框增删：list 拿到的曲目带 mcdl-media://music/<id>
   * 的播放地址，渲染层没有「按路径读文件」的能力。
   *   list()        → { version, tracks: [{ id, name, fileName, url, missing }] }
   *   pick()        → { canceled, added, dropped, skipped, limit, tracks }
   *                   added 是真正入库的条数；列表满时没写进去的算 dropped
   *   remove(id)    → { version, tracks }
   *   clear()       → { version, tracks }
   */
  music: {
    list: () => ipcRenderer.invoke('music:list'),
    pick: () => ipcRenderer.invoke('music:pick'),
    remove: (id) => ipcRenderer.invoke('music:remove', String(id || '')),
    clear: () => ipcRenderer.invoke('music:clear')
  },

  /**
   * 崩溃恢复页（renderer/recovery.html）专用的最小接口。
   *
   * 恢复页刻意不加载 renderer.js / 主包（主包本身可能就是崩溃原因），
   * 所以它能用的只有这三个动作，都在主进程里实现。
   */
  reloadFromRecovery: () => ipcRenderer.invoke('recovery:reload'),

  resetWorkspace: () => ipcRenderer.invoke('recovery:reset-workspace'),

  exportDiagnostics: () => ipcRenderer.invoke('recovery:export-diagnostics'),

  /**
   * 弹窗里的「可点击面板」：在系统浏览器打开 http(s) 页面。
   */
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  /**
   * 文本框原生右键菜单（撤销 / 重做 / 剪切 / 复制 / 粘贴 / 删除 / 全选）。
   *
   * 菜单由主进程用 Menu.popup 弹出，编辑动作走 Chromium 原生编辑命令，
   * 所以中文输入法的撤销栈不会被 execCommand 打断。
   * 渲染层只负责报告焦点控件的状态（是否可编辑 / 有选中 / 是否密码框）。
   */
  showTextContextMenu: (payload) => ipcRenderer.invoke('ui:context-menu', payload || {}),

  /**
   * 取消一个长任务（安装 / 下载）。返回 false 表示任务已经结束。
   * taskId 由渲染层的 runTask() 生成，并随原有 IPC 一起传下来。
   */
  cancelTask: (taskId) => ipcRenderer.invoke('task:cancel', String(taskId || '')),

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
