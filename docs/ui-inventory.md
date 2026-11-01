# MCDL Launcher 按钮/控件全量清单

> 生成方式：静态扫描 `HMCL/src/main/java/org/jackhuang/hmcl/ui/**/*.java`。
> 「中文文案」由 `i18n` key 在 `I18N_zh_Hans.properties` 中解析；`（运行时赋值）` 表示文案/状态在构建后动态设置；`（见对应导航页签）` 表示页签标签由其导航项给出。

## 概览

| 层级 | 控件行数 | 说明 |
|---|---:|---|
| L1 | 11 | 主窗口骨架（标题栏 + 侧边栏） |
| L2 | 30 | 侧边栏直达页 |
| L3 | 73 | 二级页签 / 详情页 |
| L4 | 63 | 三级详情 / 列表页 |
| L5 | 37 | 弹窗 / 向导 |
| 共享 | 70 | 共享组件/框架（各页复用） |
| **合计** | **284** | |

## 按类型统计

| 控件类型 | 数量 |
|---|---:|
| JFXButton | 75 |
| IconedMenuItem | 59 |
| 可点击面板 | 24 |
| 导航页签 | 23 |
| 强调按钮 | 20 |
| TabItem | 20 |
| LineToggleButton | 14 |
| LineSelectButton | 14 |
| 导航项 | 12 |
| AdvancedListItem | 9 |
| LineButton | 5 |
| LineButton·外部链接 | 3 |
| AccountAdvancedListItem | 2 |
| Button | 1 |
| ToggleButton | 1 |
| GameAdvancedListItem | 1 |
| LineButton·导航 | 1 |

## 明细

### L1 · 主窗口骨架（标题栏 + 侧边栏）（11 项）

| # | 页面 | 位置 | 类型 | i18n key | 中文文案 | 动作/去向 |
|---:|---|---|---|---|---|---|
| 83 | 标题栏 | decorator/MainWindowPane.java:182 | JFXButton |  | 帮助（打开日志文件夹） | 打开日志文件夹 |
| 84 | 标题栏 | decorator/MainWindowPane.java:193 | JFXButton |  | 最小化 | 最小化窗口 |
| 85 | 标题栏 | decorator/MainWindowPane.java:200 | JFXButton |  | 关闭 | 关闭窗口 |
| 86 | 标题栏 | decorator/MainWindowPane.java:264 | JFXButton |  | 返回 | 返回上一页 |
| 87 | 标题栏 | decorator/MainWindowPane.java:276 | JFXButton |  | 关闭当前页 | 关闭当前页面 |
| 88 | 标题栏 | decorator/MainWindowPane.java:315 | JFXButton |  | 刷新 | 刷新当前页面 |
| 272 | 主窗口侧边栏 | main/RootPage.java:98 | AccountAdvancedListItem |  | 账户（显示当前账户名） | 跳转 账户页 getAccountListPage() |
| 273 | 主窗口侧边栏 | main/RootPage.java:104 | GameAdvancedListItem |  | 游戏（显示当前实例名） | 跳转 实例设置 / 实例列表 |
| 274 | 主窗口侧边栏 | main/RootPage.java:125 | AdvancedListItem | instance.manage | 实例列表 | 动作 e -> Controllers.navigate(Controllers.getGameListPage())); |
| 275 | 主窗口侧边栏 | main/RootPage.java:132 | AdvancedListItem | download | 下载 | 动作 e -> Controllers.navigate(Controllers.getDownloadPage())); |
| 276 | 主窗口侧边栏 | main/RootPage.java:142 | AdvancedListItem | settings | 设置 | 跳转 设置页 getSettingsPage() |

### L2 · 侧边栏直达页（30 项）

| # | 页面 | 位置 | 类型 | i18n key | 中文文案 | 动作/去向 |
|---:|---|---|---|---|---|---|
| 247 | 设置中心 | main/LauncherSettingsPage.java:42 | TabItem | settings.type.global.manage | 全局游戏设置 | 页签容器 |
| 248 | 设置中心 | main/LauncherSettingsPage.java:43 | TabItem | java.management | Java 管理 | 页签容器 |
| 249 | 设置中心 | main/LauncherSettingsPage.java:44 | TabItem | settings.launcher.general | 通用 | 页签容器 |
| 250 | 设置中心 | main/LauncherSettingsPage.java:45 | TabItem | settings.launcher.appearance | 外观 | 页签容器 |
| 251 | 设置中心 | main/LauncherSettingsPage.java:46 | TabItem | download | 下载 | 页签容器 |
| 252 | 设置中心 | main/LauncherSettingsPage.java:47 | TabItem | about | 关于 | 页签容器 |
| 253 | 设置中心 | main/LauncherSettingsPage.java:60 | 导航页签 | settings.type.global.manage | 全局游戏设置 | 切换页签 |
| 254 | 设置中心 | main/LauncherSettingsPage.java:61 | 导航页签 | java.management | Java 管理 | 切换页签 |
| 255 | 设置中心 | main/LauncherSettingsPage.java:63 | 导航页签 | settings.launcher.general | 通用 | 切换页签 |
| 256 | 设置中心 | main/LauncherSettingsPage.java:64 | 导航页签 | settings.launcher.appearance | 外观 | 切换页签 |
| 257 | 设置中心 | main/LauncherSettingsPage.java:65 | 导航页签 | download | 下载 | 切换页签 |
| 258 | 设置中心 | main/LauncherSettingsPage.java:67 | 导航页签 | about | 关于 | 切换页签 |
| 186 | 实例列表 | instances/GameListPage.java:70 | IconedMenuItem | button.edit | 修改 |  |
| 187 | 实例列表 | instances/GameListPage.java:84 | AdvancedListItem | game_directory.new | 添加游戏文件夹 | 动作 e -> Controllers.navigate(new GameDirectoryPage(null))); |
| 188 | 实例列表 | instances/GameListPage.java:102 | 导航项 | settings.type.global.manage | 全局游戏设置 |  |
| 93 | 下载中心 | download/DownloadPage.java:92 | TabItem | install.installer.game | Minecraft |  |
| 94 | 下载中心 | download/DownloadPage.java:103 | 强调按钮 | install.modpack | 安装整合包 |  |
| 95 | 下载中心 | download/DownloadPage.java:129 | 导航页签 | game | 游戏 | 切换页签 |
| 96 | 下载中心 | download/DownloadPage.java:130 | 导航页签 | modpack | 整合包 | 切换页签 |
| 97 | 下载中心 | download/DownloadPage.java:132 | 导航页签 | mods | 模组 | 切换页签 |
| 98 | 下载中心 | download/DownloadPage.java:133 | 导航页签 | resourcepack | 资源包 | 切换页签 |
| 99 | 下载中心 | download/DownloadPage.java:134 | 导航页签 | download.shader | 光影 | 切换页签 |
| 100 | 下载中心 | download/DownloadPage.java:135 | 导航页签 | world | 世界 | 切换页签 |
| 101 | 下载中心 | download/DownloadPage.java:143 | TabItem |  | （见对应导航页签） | 页签容器 |
| 259 | 游戏主页 | main/MainPage.java:140 | JFXButton |  | （运行时赋值） |  |
| 260 | 游戏主页 | main/MainPage.java:177 | JFXButton |  | （运行时赋值） | 动作 e -> { |
| 33 | 账户 | account/AccountListPage.java:107 | AdvancedListItem | account.methods.microsoft | 微软账户 | 动作 e -> { |
| 34 | 账户 | account/AccountListPage.java:119 | AdvancedListItem | account.methods.offline | 离线模式 | 动作 e -> { |
| 35 | 账户 | account/AccountListPage.java:133 | AdvancedListItem |  | （运行时赋值） | 动作 e -> { |
| 36 | 账户 | account/AccountListPage.java:186 | AdvancedListItem | account.injector.add | 添加认证服务器 | 动作 e -> { |

### L3 · 二级页签 / 详情页（73 项）

| # | 页面 | 位置 | 类型 | i18n key | 中文文案 | 动作/去向 |
|---:|---|---|---|---|---|---|
| 246 | Java 管理 | main/JavaManagementPage.java:266 | JFXButton |  | （运行时赋值） | 动作 e -> { |
| 108 | 版本列表 | download/VersionsPage.java:177 | 可点击面板 |  | （运行时赋值） |  |
| 109 | 版本列表 | download/VersionsPage.java:346 | 强调按钮 | button.refresh | 刷新 |  |
| 110 | 版本列表 | download/VersionsPage.java:410 | 可点击面板 |  | （运行时赋值） |  |
| 111 | 版本列表 | download/VersionsPage.java:419 | 可点击面板 |  | （运行时赋值） |  |
| 261 | 个性化 | main/PersonalizationPage.java:97 | JFXButton |  | （运行时赋值） |  |
| 262 | 个性化 | main/PersonalizationPage.java:398 | LineButton·导航 | theme_pack.theme | 主题 | 动作 event -> |
| 263 | 个性化 | main/PersonalizationPage.java:407 | LineButton | theme_pack.export | 导出当前主题 | 动作 event -> exportCurrentThemePack()); |
| 264 | 个性化 | main/PersonalizationPage.java:420 | LineSelectButton | settings.launcher.brightness | 主题模式 |  |
| 265 | 个性化 | main/PersonalizationPage.java:605 | LineSelectButton | settings.launcher.theme_color_style | 色彩模式 |  |
| 266 | 个性化 | main/PersonalizationPage.java:852 | LineToggleButton | launcher.background.network.cache | 缓存网络图片 |  |
| 267 | 个性化 | main/PersonalizationPage.java:897 | LineSelectButton | launcher.background.load_policy | 背景加载方式 |  |
| 268 | 个性化 | main/PersonalizationPage.java:1064 | LineToggleButton | settings.launcher.title_transparent | 标题栏透明 |  |
| 269 | 个性化 | main/PersonalizationPage.java:1128 | LineToggleButton | settings.launcher.window_transparent | 窗口透明 |  |
| 270 | 个性化 | main/PersonalizationPage.java:1155 | LineToggleButton | settings.launcher.turn_off_animations | 关闭动画 |  |
| 271 | 个性化 | main/PersonalizationPage.java:1254 | LineSelectButton | settings.launcher.font.anti_aliasing | 抗锯齿 |  |
| 236 | 关于 | main/AboutPage.java:52 | LineButton·外部链接 |  | （运行时赋值） |  |
| 237 | 关于 | main/AboutPage.java:159 | LineButton·外部链接 | about.claim | 用户协议 |  |
| 238 | 关于 | main/AboutPage.java:164 | LineButton·外部链接 | about.open_source | 开源 |  |
| 239 | 关于 | main/AboutPage.java:205 | LineButton |  | （运行时赋值） | 动作 event -> FXUtils.openLink(link)); |
| 131 | 内容列表 | instances/DownloadListPage.java:490 | 强调按钮 | search | 搜索 |  |
| 132 | 内容列表 | instances/DownloadListPage.java:590 | 可点击面板 |  | （运行时赋值） |  |
| 141 | 实例详情 | instances/GameInstancePage.java:83 | TabItem | settings.game | 游戏设置 | 页签容器 |
| 142 | 实例详情 | instances/GameInstancePage.java:84 | TabItem | settings.tabs.installers | 自动安装 | 页签容器 |
| 143 | 实例详情 | instances/GameInstancePage.java:85 | TabItem | mods.manage | 模组管理 | 页签容器 |
| 144 | 实例详情 | instances/GameInstancePage.java:86 | TabItem | resourcepack.manage | 资源包管理 | 页签容器 |
| 145 | 实例详情 | instances/GameInstancePage.java:87 | TabItem | world.manage | 世界管理 | 页签容器 |
| 146 | 实例详情 | instances/GameInstancePage.java:88 | TabItem | schematics.manage | 原理图管理 | 页签容器 |
| 147 | 实例详情 | instances/GameInstancePage.java:89 | TabItem |  | （见对应导航页签） | 页签容器 |
| 148 | 实例详情 | instances/GameInstancePage.java:356 | 导航页签 | settings.game | 游戏设置 | 切换页签 |
| 149 | 实例详情 | instances/GameInstancePage.java:357 | 导航页签 | settings.tabs.installers | 自动安装 | 切换页签 |
| 150 | 实例详情 | instances/GameInstancePage.java:358 | 导航页签 | mods.manage | 模组管理 | 切换页签 |
| 151 | 实例详情 | instances/GameInstancePage.java:359 | 导航页签 | resourcepack.manage | 资源包管理 | 切换页签 |
| 152 | 实例详情 | instances/GameInstancePage.java:360 | 导航页签 | world.manage | 世界管理 | 切换页签 |
| 153 | 实例详情 | instances/GameInstancePage.java:361 | 导航页签 | schematics.manage | 原理图管理 | 切换页签 |
| 154 | 实例详情 | instances/GameInstancePage.java:367 | IconedMenuItem | folder.game | 实例运行文件夹 |  |
| 155 | 实例详情 | instances/GameInstancePage.java:368 | IconedMenuItem | folder.config | 配置文件夹 |  |
| 156 | 实例详情 | instances/GameInstancePage.java:370 | IconedMenuItem | folder.mod | 模组文件夹 |  |
| 157 | 实例详情 | instances/GameInstancePage.java:371 | IconedMenuItem | folder.resourcepacks | 资源包文件夹 |  |
| 158 | 实例详情 | instances/GameInstancePage.java:372 | IconedMenuItem | folder.saves | 世界文件夹 |  |
| 159 | 实例详情 | instances/GameInstancePage.java:373 | IconedMenuItem | folder.schematics | 原理图文件夹 |  |
| 160 | 实例详情 | instances/GameInstancePage.java:374 | IconedMenuItem | folder.shaderpacks | 光影包文件夹 |  |
| 161 | 实例详情 | instances/GameInstancePage.java:375 | IconedMenuItem | folder.screenshots | 截图文件夹 |  |
| 162 | 实例详情 | instances/GameInstancePage.java:377 | IconedMenuItem | folder.logs | 日志文件夹 |  |
| 163 | 实例详情 | instances/GameInstancePage.java:378 | IconedMenuItem | folder.crash-reports | 崩溃报告文件夹 |  |
| 164 | 实例详情 | instances/GameInstancePage.java:384 | IconedMenuItem | instance.launch.test | 测试游戏 |  |
| 165 | 实例详情 | instances/GameInstancePage.java:385 | IconedMenuItem | instance.launch_script | 生成启动脚本 |  |
| 166 | 实例详情 | instances/GameInstancePage.java:387 | IconedMenuItem | instance.manage.rename | 重命名该实例 |  |
| 167 | 实例详情 | instances/GameInstancePage.java:388 | IconedMenuItem | instance.manage.duplicate | 复制游戏实例 |  |
| 168 | 实例详情 | instances/GameInstancePage.java:389 | IconedMenuItem | instance.manage.remove | 删除该实例 |  |
| 169 | 实例详情 | instances/GameInstancePage.java:390 | IconedMenuItem | modpack.export | 导出整合包 |  |
| 170 | 实例详情 | instances/GameInstancePage.java:394 | IconedMenuItem | screenshots.manage | 截图管理 |  |
| 171 | 实例详情 | instances/GameInstancePage.java:396 | IconedMenuItem | instance.manage.redownload_assets_index | 更新游戏资源文件 |  |
| 172 | 实例详情 | instances/GameInstancePage.java:397 | IconedMenuItem | instance.manage.remove_assets | 删除所有游戏资源文件 |  |
| 173 | 实例详情 | instances/GameInstancePage.java:398 | IconedMenuItem | instance.manage.remove_libraries | 删除所有库文件 |  |
| 174 | 实例详情 | instances/GameInstancePage.java:399 | IconedMenuItem | instance.manage.clean | 清理游戏文件夹 |  |
| 175 | 实例详情 | instances/GameInstancePage.java:403 | 导航项 | instance.update | 更新整合包 |  |
| 176 | 实例详情 | instances/GameInstancePage.java:406 | 导航项 | instance.launch.test | 测试游戏 | 动作 e -> browsePopup.show(browseMenuItem, JFXPopup.PopupVPosition.BOTTOM, JFXPopup.PopupHPosition.LEFT, browseMenuItem.getWidth( |
| 177 | 实例详情 | instances/GameInstancePage.java:407 | 导航项 | settings.game.exploration | 浏览 | 动作 e -> browsePopup.show(browseMenuItem, JFXPopup.PopupVPosition.BOTTOM, JFXPopup.PopupHPosition.LEFT, browseMenuItem.getWidth( |
| 178 | 实例详情 | instances/GameInstancePage.java:410 | 导航项 | settings.game.management | 管理 | 动作 e -> managementPopup.show(managementItem, JFXPopup.PopupVPosition.BOTTOM, JFXPopup.PopupHPosition.LEFT, managementItem.getWidth( |
| 277 | 通用设置 | main/SettingsPage.java:67 | LineSelectButton | settings.launcher.language | 语言 |  |
| 278 | 通用设置 | main/SettingsPage.java:94 | LineToggleButton | settings.launcher.disable_april_fools | 不启用愚人节功能 |  |
| 279 | 通用设置 | main/SettingsPage.java:108 | JFXButton | settings.launcher.launcher_log.reveal | 打开日志文件夹 | 动作 e -> openLogFolder()); |
| 240 | 下载设置 | main/DownloadSettingsPage.java:70 | LineSelectButton | settings.launcher.version_list_source | 版本列表源 |  |
| 241 | 下载设置 | main/DownloadSettingsPage.java:77 | LineSelectButton | settings.launcher.download_source | 下载源 |  |
| 242 | 下载设置 | main/DownloadSettingsPage.java:84 | LineSelectButton | settings.launcher.default_addon_source | 附加内容默认下载源 |  |
| 120 | 游戏设置 | game/GameSettingsPage.java:187 | LineSelectButton | settings.type.global.preset | 预设 |  |
| 121 | 游戏设置 | game/GameSettingsPage.java:334 | LineSelectButton | settings.game.default_isolation | 默认版本隔离策略 |  |
| 122 | 游戏设置 | game/GameSettingsPage.java:351 | LineToggleButton | settings.game.isolation | 版本隔离 |  |
| 123 | 游戏设置 | game/GameSettingsPage.java:1348 | JFXButton |  | （运行时赋值） |  |
| 124 | 游戏设置 | game/GameSettingsPage.java:2620 | LineSelectButton |  | （运行时赋值） |  |
| 102 | 整合包 | download/ModpackPage.java:85 | 强调按钮 | modpack.optional_files | 可选文件 |  |
| 103 | 整合包 | download/ModpackPage.java:90 | 强调按钮 | button.install | 安装 |  |

### L4 · 三级详情 / 列表页（63 项）

| # | 页面 | 位置 | 类型 | i18n key | 中文文案 | 动作/去向 |
|---:|---|---|---|---|---|---|
| 283 | NBT 编辑器 | nbt/NBTEditorPage.java:65 | 强调按钮 | button.save | 保存 |  |
| 284 | NBT 编辑器 | nbt/NBTEditorPage.java:75 | 强调按钮 | button.cancel | 取消 |  |
| 105 | 安装向导-可选文件 | download/OptionalFilesPage.java:131 | 强调按钮 | button.install | 安装 |  |
| 106 | 安装向导-可选文件 | download/OptionalFilesPage.java:187 | JFXButton |  | （运行时赋值） |  |
| 107 | 安装向导-可选文件 | download/OptionalFilesPage.java:289 | JFXButton | button.ok | 确定 | 动作 e -> fireEvent(new DialogCloseEvent())); |
| 119 | 导出向导-类型 | export/ModpackTypeSelectionPage.java:48 | JFXButton |  | （运行时赋值） | 动作 e -> { |
| 112 | 导出向导-文件 | export/ModpackFileSelectionPage.java:83 | 强调按钮 | wizard.next | 下一步 > |  |
| 113 | 导出向导-信息 | export/ModpackInfoPage.java:293 | LineSelectButton | account.injector.server | 认证服务器 |  |
| 114 | 导出向导-信息 | export/ModpackInfoPage.java:308 | LineToggleButton | modpack.wizard.step.initialization.force_update | 强制升级整合包至最新版本 (需要自建服务器) |  |
| 115 | 导出向导-信息 | export/ModpackInfoPage.java:316 | LineToggleButton | modpack.wizard.step.initialization.include_launcher | 包含启动器 |  |
| 116 | 导出向导-信息 | export/ModpackInfoPage.java:325 | LineToggleButton | modpack.wizard.step.initialization.no_create_remote_files | 不匹配远程文件 |  |
| 117 | 导出向导-信息 | export/ModpackInfoPage.java:333 | LineToggleButton | modpack.wizard.step.initialization.skip_curseforge_remote_files | 不匹配 CurseForge 远程资源 |  |
| 118 | 导出向导-信息 | export/ModpackInfoPage.java:346 | 强调按钮 | wizard.next | 下一步 > |  |
| 92 | 加载器安装列表 | download/AbstractInstallersPage.java:168 | 强调按钮 | button.install | 安装 |  |
| 197 | 截图列表 | instances/ScreenshotsPage.java:361 | JFXButton | screenshots.set_as_bg | 设为启动器背景 | 动作 e -> { |
| 198 | 截图列表 | instances/ScreenshotsPage.java:369 | JFXButton | menu.copy | 复制 | 动作 e -> { |
| 199 | 截图列表 | instances/ScreenshotsPage.java:376 | JFXButton | button.ok | 确定 | 动作 e -> fireEvent(new DialogCloseEvent())); |
| 192 | 模组列表 | instances/ModListPage.java:711 | JFXButton | button.ok | 确定 | 动作 e -> fireEvent(new DialogCloseEvent())); |
| 193 | 模组列表 | instances/ModListPage.java:846 | IconedMenuItem |  | （运行时赋值） |  |
| 126 | 内容更新 | instances/AddonUpdatesPage.java:139 | 强调按钮 | button.export | 导出 |  |
| 127 | 内容更新 | instances/AddonUpdatesPage.java:142 | 强调按钮 | addon.check_update.confirm | 更新 |  |
| 128 | 内容更新 | instances/AddonUpdatesPage.java:145 | 强调按钮 | button.cancel | 取消 |  |
| 129 | 内容更新 | instances/AddonUpdatesPage.java:379 | 可点击面板 |  | （运行时赋值） |  |
| 130 | 内容更新 | instances/AddonUpdatesPage.java:462 | JFXButton | button.ok | 确定 | 动作 e -> fireEvent(new DialogCloseEvent())); |
| 133 | 内容下载页 | instances/DownloadPage.java:481 | 可点击面板 |  | （运行时赋值） | 弹窗 AddonVersion |
| 134 | 内容下载页 | instances/DownloadPage.java:539 | JFXButton | install.modpack | 安装整合包 | 动作 e -> { |
| 135 | 内容下载页 | instances/DownloadPage.java:549 | JFXButton | mods.save_as | 下载到本地文件夹 | 动作 e -> { |
| 136 | 内容下载页 | instances/DownloadPage.java:558 | JFXButton | button.cancel | 取消 | 动作 e -> fireEvent(new DialogCloseEvent())); |
| 137 | 内容下载页 | instances/DownloadPage.java:678 | JFXButton | button.ok | 确定 | 动作 e -> fireEvent(new DialogCloseEvent())); |
| 189 | 实例右键菜单 | instances/GameListPopupMenu.java:153 | 可点击面板 |  | （运行时赋值） |  |
| 217 | 世界管理 | instances/WorldManagePage.java:72 | TabItem |  | （见对应导航页签） | 页签容器 |
| 218 | 世界管理 | instances/WorldManagePage.java:73 | TabItem |  | （见对应导航页签） | 页签容器 |
| 219 | 世界管理 | instances/WorldManagePage.java:74 | TabItem |  | （见对应导航页签） | 页签容器 |
| 220 | 世界管理 | instances/WorldManagePage.java:203 | 导航页签 | world.info | 世界信息 | 切换页签 |
| 221 | 世界管理 | instances/WorldManagePage.java:204 | 导航页签 | world.backup | 备份管理 | 切换页签 |
| 222 | 世界管理 | instances/WorldManagePage.java:208 | 导航页签 | world.datapack | 数据包管理 | 切换页签 |
| 223 | 世界管理 | instances/WorldManagePage.java:220 | 导航项 | instance.launch | 启动游戏 |  |
| 224 | 世界管理 | instances/WorldManagePage.java:228 | IconedMenuItem | world.chunkbase.seed_map | 种子地图 |  |
| 225 | 世界管理 | instances/WorldManagePage.java:229 | IconedMenuItem | world.chunkbase.stronghold | 要塞地图 |  |
| 226 | 世界管理 | instances/WorldManagePage.java:230 | IconedMenuItem | world.chunkbase.nether_fortress | 下界要塞地图 |  |
| 227 | 世界管理 | instances/WorldManagePage.java:235 | IconedMenuItem | world.chunkbase.end_city | 末地城地图 |  |
| 228 | 世界管理 | instances/WorldManagePage.java:238 | 导航项 | world.chunkbase | 世界地图 | 动作 e ->
                                    chunkBasePopup.show(chunkBaseMenuItem,
                                            JFXPopup.PopupVPosition.BOTTOM, JFXPopup.PopupHPosition.LEFT,
                                            chunkBaseMenuItem.getWidth( |
| 229 | 世界管理 | instances/WorldManagePage.java:245 | 导航项 | settings.game.exploration | 浏览 |  |
| 230 | 世界管理 | instances/WorldManagePage.java:253 | IconedMenuItem | instance.launch | 启动游戏 |  |
| 231 | 世界管理 | instances/WorldManagePage.java:254 | IconedMenuItem | instance.launch_script | 生成启动脚本 |  |
| 232 | 世界管理 | instances/WorldManagePage.java:260 | IconedMenuItem | world.export | 导出此世界 |  |
| 233 | 世界管理 | instances/WorldManagePage.java:261 | IconedMenuItem | world.delete | 删除此世界 |  |
| 234 | 世界管理 | instances/WorldManagePage.java:262 | IconedMenuItem | world.duplicate | 复制此世界 |  |
| 235 | 世界管理 | instances/WorldManagePage.java:265 | 导航项 | settings.game.management | 管理 | 动作 e ->
                                managePopup.show(managePopupMenuItem,
                                        JFXPopup.PopupVPosition.BOTTOM, JFXPopup.PopupHPosition.LEFT,
                                        managePopupMenuItem.getWidth( |
| 201 | 世界详情 | instances/WorldInfoPage.java:216 | LineToggleButton | world.info.allow_cheats | 允许命令(作弊) |  |
| 202 | 世界详情 | instances/WorldInfoPage.java:224 | LineToggleButton | world.info.generate_features | 生成建筑 |  |
| 203 | 世界详情 | instances/WorldInfoPage.java:244 | LineSelectButton | world.info.difficulty | 难度 |  |
| 204 | 世界详情 | instances/WorldInfoPage.java:278 | LineToggleButton | world.info.difficulty_lock | 锁定难度 |  |
| 205 | 世界详情 | instances/WorldInfoPage.java:343 | LineSelectButton | world.info.player.game_type | 游戏模式 |  |
| 195 | 投影列表 | instances/SchematicsPage.java:673 | JFXButton | button.ok | 确定 | 动作 e -> fireEvent(new DialogCloseEvent())); |
| 196 | 投影列表 | instances/SchematicsPage.java:884 | 可点击面板 |  | （运行时赋值） |  |
| 90 | 游戏目录管理 | directory/GameDirectoryPage.java:127 | LineToggleButton | game_directory.use_relative_path | 若可能，游戏文件夹使用相对路径 |  |
| 91 | 游戏目录管理 | directory/GameDirectoryPage.java:150 | 强调按钮 | button.save | 保存 |  |
| 104 | 整合包类型选择 | download/ModpackSelectionPage.java:74 | JFXButton |  | （运行时赋值） | 动作 e -> action.run()); |
| 280 | 主题包管理 | main/ThemePackManagementPage.java:456 | 可点击面板 |  | （运行时赋值） |  |
| 281 | 主题包管理 | main/ThemePackManagementPage.java:477 | JFXButton | button.ok | 确定 | 动作 event -> fireEvent(new DialogCloseEvent())); |
| 282 | 主题包管理 | main/ThemePackManagementPage.java:669 | 可点击面板 |  | （运行时赋值） |  |
| 194 | 资源包列表 | instances/ResourcePackListPage.java:672 | JFXButton | button.ok | 确定 | 动作 e -> fireEvent(new DialogCloseEvent())); |

### L5 · 弹窗 / 向导（37 项）

| # | 页面 | 位置 | 类型 | i18n key | 中文文案 | 动作/去向 |
|---:|---|---|---|---|---|---|
| 243 | Java 下载提示 | main/JavaDownloadDialog.java:225 | JFXButton | download | 下载 | 动作 e -> onDownload()); |
| 244 | Java 下载提示 | main/JavaDownloadDialog.java:230 | JFXButton | button.cancel | 取消 | 动作 e -> fireEvent(new DialogCloseEvent())); |
| 245 | 安装 Java | main/JavaInstallPage.java:136 | 强调按钮 | button.install | 安装 |  |
| 23 | 安装项 | InstallerItem.java:333 | JFXButton |  | （运行时赋值） |  |
| 4 | 崩溃窗口 | CrashWindow.java:39 | Button | settings.launcher.launcher_log.reveal | 打开日志文件夹 | 动作 event -> { |
| 54 | 离线皮肤设置 | account/OfflineAccountSkinPane.java:226 | JFXButton | button.ok | 确定 | 动作 e -> { |
| 55 | 离线皮肤设置 | account/OfflineAccountSkinPane.java:235 | JFXButton | button.cancel | 取消 | 动作 e -> fireEvent(new DialogCloseEvent())); |
| 24 | 日志窗口 | LogWindow.java:288 | ToggleButton |  | （运行时赋值） |  |
| 25 | 日志窗口 | LogWindow.java:400 | JFXButton | button.export | 导出 | 动作 e -> getSkinnable().onExportLogs()); |
| 26 | 日志窗口 | LogWindow.java:403 | JFXButton | logwindow.terminate_game | 结束游戏进程 | 动作 e -> getSkinnable().onTerminateGame()); |
| 27 | 日志窗口 | LogWindow.java:408 | JFXButton | logwindow.export_dump | 导出游戏运行栈 | 动作 e -> getSkinnable().onExportDump(exportDumpPane)); |
| 28 | 日志窗口 | LogWindow.java:417 | JFXButton | button.clear | 清除 | 动作 e -> getSkinnable().onClear()); |
| 190 | 实例操作对话框 | instances/Instances.java:111 | JFXButton | button.delete | 删除 | 动作 e -> { |
| 191 | 实例操作对话框 | instances/Instances.java:337 | JFXButton | instance.empty.launch.goto_download | 前往下载页面 | 动作 e -> Controllers.navigate(Controllers.getDownloadPage())); |
| 138 | 实例图标选择 | instances/GameInstanceIconDialog.java:61 | JFXButton | button.cancel | 取消 | 动作 event -> fireEvent(new DialogCloseEvent())); |
| 139 | 实例图标选择 | instances/GameInstanceIconDialog.java:94 | 可点击面板 |  | （运行时赋值） |  |
| 140 | 实例图标选择 | instances/GameInstanceIconDialog.java:104 | 可点击面板 |  | （运行时赋值） |  |
| 45 | 添加离线账户 | account/CreateAccountPane.java:116 | JFXButton | account.login | 登录 | 动作 e -> onAccept()); |
| 46 | 添加离线账户 | account/CreateAccountPane.java:124 | JFXButton | button.cancel | 取消 | 动作 e -> onCancel()); |
| 47 | 添加离线账户 | account/CreateAccountPane.java:136 | TabItem |  | （见对应导航页签） | 页签容器 |
| 48 | 添加离线账户 | account/CreateAccountPane.java:142 | TabItem |  | （见对应导航页签） | 页签容器 |
| 49 | 添加离线账户 | account/CreateAccountPane.java:574 | JFXButton | button.cancel | 取消 | 动作 e -> latch.countDown()); |
| 50 | 添加离线账户 | account/CreateAccountPane.java:606 | 可点击面板 |  | （运行时赋值） |  |
| 38 | 添加认证服务器 | account/AddAuthlibInjectorServerPane.java:61 | JFXButton | button.cancel | 取消 | 动作 e -> onAddCancel()); |
| 39 | 添加认证服务器 | account/AddAuthlibInjectorServerPane.java:67 | JFXButton | wizard.next | 下一步 > | 动作 e -> onAddNext()); |
| 40 | 添加认证服务器 | account/AddAuthlibInjectorServerPane.java:138 | JFXButton | wizard.prev | < 上一步 | 动作 e -> onAddPrev()); |
| 41 | 添加认证服务器 | account/AddAuthlibInjectorServerPane.java:142 | JFXButton | button.cancel | 取消 | 动作 e -> onAddCancel()); |
| 42 | 添加认证服务器 | account/AddAuthlibInjectorServerPane.java:146 | JFXButton | wizard.finish | 完成 | 动作 e -> onAddFinish()); |
| 51 | 微软登录 | account/MicrosoftAccountLoginPane.java:88 | JFXButton | account.login | 登录 |  |
| 52 | 微软登录 | account/MicrosoftAccountLoginPane.java:95 | JFXButton | button.cancel | 取消 | 动作 e -> onCancel()); |
| 53 | 微软登录 | account/MicrosoftAccountLoginPane.java:216 | 可点击面板 |  | （运行时赋值） |  |
| 18 | 游戏崩溃窗口 | GameCrashWindow.java:419 | 强调按钮 | logwindow.export_game_crash_logs | 导出游戏崩溃信息 |  |
| 19 | 游戏崩溃窗口 | GameCrashWindow.java:446 | 强调按钮 | logwindow.title | 日志 |  |
| 20 | 游戏崩溃窗口 | GameCrashWindow.java:449 | 强调按钮 | help | 帮助 |  |
| 125 | 游戏设置预设 | game/PresetManagementPane.java:65 | LineButton | settings.type.global.preset.create | 新建预设 | 动作 event -> createPreset()); |
| 43 | 正版登录对话框 | account/ClassicAccountLoginDialog.java:70 | JFXButton | button.ok | 确定 | 动作 e -> onAccept()); |
| 44 | 正版登录对话框 | account/ClassicAccountLoginDialog.java:74 | JFXButton | button.cancel | 取消 | 动作 e -> onCancel()); |

### 共享 · 共享组件/框架（各页复用）（70 项）

| # | 页面 | 位置 | 类型 | i18n key | 中文文案 | 动作/去向 |
|---:|---|---|---|---|---|---|
| 67 | 共享组件/框架 | construct/IconedMenuItem.java:17 | 可点击面板 |  | （运行时赋值） |  |
| 68 | 共享组件/框架 | construct/IconedMenuItem.java:19 | 可点击面板 |  | （运行时赋值） |  |
| 62 | 共享组件/框架 | construct/DialogPane.java:20 | JFXButton | button.cancel | 取消 | 动作 e -> onCancel()); |
| 71 | 共享组件/框架 | construct/LineButton.java:20 | LineButton |  | （运行时赋值） | 动作 event -> FXUtils.openLink(url)); |
| 72 | 共享组件/框架 | construct/LineButton.java:26 | LineButton |  | （运行时赋值） | 动作 event -> FXUtils.openLink(url)); |
| 63 | 共享组件/框架 | construct/DialogPane.java:28 | JFXButton | button.ok | 确定 | 动作 e -> onAccept()); |
| 66 | 共享组件/框架 | construct/FontComboBox.java:42 | 可点击面板 |  | （运行时赋值） |  |
| 31 | 共享组件/框架 | account/AccountListItemSkin.java:43 | 可点击面板 |  | （运行时赋值） |  |
| 37 | 共享组件/框架 | account/AccountListPopupMenu.java:45 | AccountAdvancedListItem |  | （运行时赋值） | 动作 e -> { |
| 69 | 共享组件/框架 | construct/InputDialogPane.java:49 | JFXButton | button.ok | 确定 | 动作 e -> { |
| 73 | 共享组件/框架 | construct/LineInheritableToggleButton.java:50 | JFXButton |  | （运行时赋值） |  |
| 89 | 共享组件/框架 | directory/GameDirectoryListItemSkin.java:52 | 可点击面板 |  | （运行时赋值） |  |
| 70 | 共享组件/框架 | construct/InputDialogPane.java:53 | JFXButton | button.cancel | 取消 | 动作 e -> fireEvent(new DialogCloseEvent())); |
| 56 | 共享组件/框架 | construct/AdvancedListBox.java:57 | AdvancedListItem |  | （运行时赋值） | 动作 e -> onAction.run()); |
| 200 | 共享组件/框架 | instances/WorldExportPageSkin.java:60 | 强调按钮 | button.export | 导出 |  |
| 57 | 共享组件/框架 | construct/AdvancedListBox.java:66 | 导航项 |  | （运行时赋值） |  |
| 82 | 共享组件/框架 | construct/TaskExecutorDialogPane.java:66 | JFXButton | button.cancel | 取消 | 动作 e -> { |
| 58 | 共享组件/框架 | construct/AdvancedListBox.java:67 | 导航项 |  | （运行时赋值） |  |
| 59 | 共享组件/框架 | construct/AdvancedListBox.java:70 | 导航项 |  | （运行时赋值） |  |
| 76 | 共享组件/框架 | construct/MenuUpDownButton.java:71 | JFXButton |  | （运行时赋值） | 动作 e -> { |
| 29 | 共享组件/框架 | ToolbarListPageSkin.java:71 | JFXButton |  | （运行时赋值） | 动作 e -> onClick.run()); |
| 30 | 共享组件/框架 | ToolbarListPageSkin.java:80 | JFXButton |  | （运行时赋值） | 动作 e -> onClick.run()); |
| 32 | 共享组件/框架 | account/AccountListItemSkin.java:81 | JFXButton |  | （运行时赋值） | 动作 e -> { |
| 60 | 共享组件/框架 | construct/AdvancedListBox.java:85 | 导航页签 |  | （动态/程序设置） | 切换页签 |
| 75 | 共享组件/框架 | construct/MDListCell.java:87 | 可点击面板 |  | （运行时赋值） |  |
| 64 | 共享组件/框架 | construct/FileSelector.java:90 | IconedMenuItem | selector.choose_file | 选择文件 |  |
| 65 | 共享组件/框架 | construct/FileSelector.java:91 | IconedMenuItem | selector.choose_directory | 选择文件夹 |  |
| 61 | 共享组件/框架 | construct/AdvancedListBox.java:95 | 导航页签 |  | （动态/程序设置） | 切换页签 |
| 74 | 共享组件/框架 | construct/LineSelectButton.java:103 | 可点击面板 |  | （运行时赋值） |  |
| 77 | 共享组件/框架 | construct/MessageDialogPane.java:148 | JFXButton |  | （运行时赋值） | 动作 e -> action.run()); |
| 78 | 共享组件/框架 | construct/MessageDialogPane.java:158 | JFXButton | button.ok | 确定 | 动作 e -> ok.run()); |
| 21 | 共享组件/框架 | HTMLRenderer.java:167 | 可点击面板 |  | （运行时赋值） |  |
| 79 | 共享组件/框架 | construct/MessageDialogPane.java:173 | JFXButton |  | （运行时赋值） | 动作 e -> cancel.run()); |
| 80 | 共享组件/框架 | construct/MessageDialogPane.java:185 | JFXButton | button.yes | 是 | 动作 e -> yes.run()); |
| 179 | 共享组件/框架 | instances/GameListCell.java:186 | IconedMenuItem | instance.launch.test | 测试游戏 |  |
| 180 | 共享组件/框架 | instances/GameListCell.java:187 | IconedMenuItem | instance.launch_script | 生成启动脚本 |  |
| 181 | 共享组件/框架 | instances/GameListCell.java:189 | IconedMenuItem | instance.manage.rename | 重命名该实例 |  |
| 182 | 共享组件/框架 | instances/GameListCell.java:190 | IconedMenuItem | instance.manage.duplicate | 复制游戏实例 |  |
| 183 | 共享组件/框架 | instances/GameListCell.java:191 | IconedMenuItem | instance.manage.remove | 删除该实例 |  |
| 184 | 共享组件/框架 | instances/GameListCell.java:192 | IconedMenuItem | modpack.export | 导出整合包 |  |
| 185 | 共享组件/框架 | instances/GameListCell.java:194 | IconedMenuItem | folder.game | 实例运行文件夹 |  |
| 81 | 共享组件/框架 | construct/SpinnerPane.java:203 | 可点击面板 |  | （运行时赋值） |  |
| 22 | 共享组件/框架 | HTMLRenderer.java:246 | 可点击面板 |  | （运行时赋值） |  |
| 1 | 共享组件/框架 | Controllers.java:347 | JFXButton | launcher.agreement.accept | 同意 | 动作 e -> { |
| 2 | 共享组件/框架 | Controllers.java:354 | JFXButton | launcher.agreement.decline | 拒绝 | 动作 e -> javafx.application.Platform.exit()); |
| 206 | 共享组件/框架 | instances/WorldListPage.java:371 | IconedMenuItem | instance.launch_and_enter_world | 进入世界 |  |
| 207 | 共享组件/框架 | instances/WorldListPage.java:376 | IconedMenuItem | instance.launch_script | 生成启动脚本 |  |
| 208 | 共享组件/框架 | instances/WorldListPage.java:381 | IconedMenuItem | world.manage.button | 管理此世界 |  |
| 209 | 共享组件/框架 | instances/WorldListPage.java:386 | IconedMenuItem | world.chunkbase.seed_map | 种子地图 |  |
| 210 | 共享组件/框架 | instances/WorldListPage.java:387 | IconedMenuItem | world.chunkbase.stronghold | 要塞地图 |  |
| 211 | 共享组件/框架 | instances/WorldListPage.java:388 | IconedMenuItem | world.chunkbase.nether_fortress | 下界要塞地图 |  |
| 212 | 共享组件/框架 | instances/WorldListPage.java:392 | IconedMenuItem | world.chunkbase.end_city | 末地城地图 |  |
| 213 | 共享组件/框架 | instances/WorldListPage.java:396 | IconedMenuItem | world.export | 导出此世界 |  |
| 214 | 共享组件/框架 | instances/WorldListPage.java:399 | IconedMenuItem | world.delete | 删除此世界 |  |
| 215 | 共享组件/框架 | instances/WorldListPage.java:402 | IconedMenuItem | world.duplicate | 复制此世界 |  |
| 216 | 共享组件/框架 | instances/WorldListPage.java:414 | IconedMenuItem | folder.world | 世界文件夹 |  |
| 3 | 共享组件/框架 | Controllers.java:493 | JFXButton | button.ok | 确定 | 动作 e -> ok.run()); |
| 5 | 共享组件/框架 | FXUtils.java:1013 | JFXButton |  | （运行时赋值） |  |
| 6 | 共享组件/框架 | FXUtils.java:1020 | JFXButton |  | （运行时赋值） |  |
| 7 | 共享组件/框架 | FXUtils.java:1026 | JFXButton |  | （运行时赋值） |  |
| 8 | 共享组件/框架 | FXUtils.java:1033 | JFXButton |  | （运行时赋值） | 动作 e -> { |
| 9 | 共享组件/框架 | FXUtils.java:1456 | IconedMenuItem | menu.undo | 撤销 |  |
| 10 | 共享组件/框架 | FXUtils.java:1457 | IconedMenuItem | menu.redo | 重做 |  |
| 11 | 共享组件/框架 | FXUtils.java:1458 | IconedMenuItem | menu.cut | 剪切 |  |
| 12 | 共享组件/框架 | FXUtils.java:1459 | IconedMenuItem | menu.copy | 复制 |  |
| 13 | 共享组件/框架 | FXUtils.java:1460 | IconedMenuItem | menu.paste | 粘贴 |  |
| 14 | 共享组件/框架 | FXUtils.java:1461 | IconedMenuItem | menu.deleteselection | 删除 |  |
| 15 | 共享组件/框架 | FXUtils.java:1462 | IconedMenuItem | menu.selectall | 全选 |  |
| 16 | 共享组件/框架 | FXUtils.java:1572 | JFXButton | button.cancel | 取消 | 动作 e -> fireEvent(new DialogCloseEvent())); |
| 17 | 共享组件/框架 | FXUtils.java:1576 | JFXButton | button.ok | 确定 | 动作 e -> { |

## 未计入

- 随数据动态生成的行（实例、模组、世界、截图、日志等列表行）与其内部按钮
- 右键菜单项由 `IconedMenuItem`/`MenuItem` 动态拼装的部分（已列出源码中显式构造的那些）
- `construct/` 之外的第三方控件（JFoenix 内部按钮）
