# MCDL Launcher UI 实现状态（验收基准）

> **基线**：`ui-tree-controls.html` —— 60 个节点 / 284 项控件（2026-11-01 静态扫描 HMCL 上游 `ui/**/*.java`）
> **最近核对**：2026-11-02 23:58 · 对照 `electron/renderer/index.html`(300 KB) + `renderer.js`(428 KB) + `main.js`(205 KB / **114 条 IPC**)
> **自动化验证**：`cd electron && npm test` → **284 / 284 pass**（`node --test --test-isolation=none`，约 1 s）
> **图例**：✅ 完成 ｜ ⚠️ 部分 ｜ ⛔ 未做 ｜ ➖ 不做（设计决定）｜ ➕ 清单外新增
> **口径**：`项数` = 基线控件行数；`已做` 按**功能可用**计（不按"文件/元素是否存在"计）；`disabled` 入口计为未做。

---

## 0. 总览

| 分组 | 节点 | 项数 | 已做 | 剩余 | 完成率 | 状态 |
|---|---:|---:|---:|---:|---:|---|
| L1 骨架（标题栏 + 侧边栏） | 3 | 11 | 11 | 0 | 100% | ✅ |
| 账户（含 5 弹窗） | 6 | 22 | 22 | 0 | 100% | ✅ |
| 游戏 / 实例详情 | 13 | 81 | 75 | 6 | 93% | ⚠️ |
| 实例管理 | 4 | 8 | 8 | 0 | 100% | ✅ |
| 下载中心 | 11 | 26 | 26 | 0 | 100% | ✅ |
| 设置中心 | 12 | 47 | 38 | 9 | ≈81% | ⚠️（3 项不做 + 4 项暂不支持 + 2 项未做） |
| 导出整合包向导 | 4 | 8 | 8 | 0 | 100% | ✅ |
| 全局弹窗 | 6 | 11 | 11 | 0 | 100% | ✅ |
| **页面级小计** | **59** | **214** | **199** | **15** | **≈93%** | ⚠️ |
| 共享组件 / 框架 | 1 | 70 | 64 | 2 | ≈91% | ✅（4 不做 + 2 待定） |
| **合计** | **60** | **284** | **263** | **21** | **≈93%** | ⚠️ |

> 剩余 21 项 = **7 项「不做」**（主题包管理 3 + FontComboBox / MenuUpDownButton / SpinnerPane / LineInheritableToggleButton 4）
> \+ **4 项「暂不支持」**（抗锯齿、缓存网络图片、标题栏透明、窗口透明——顶栏已明确标注）
> \+ **10 项实操**：内容更新 5（AddonUpdatesPage）、主题 / 主题包入口 2、HTMLRenderer 2（待定，等新闻 API）、主页主视觉 / 新闻 1。
>
> **口径修正（2026-11-02 逐项复核）**：共享组件 64 / 4 不做 / 2 待定；工具栏基座已补齐（`createToolbar` + 4 处迁移）。
> **主题轮修正**：个性化从「11/11 ✅」改为 **5/11** —— 主题模式、色彩模式、导出主题、背景加载方式、关闭动画真正可用；
> 抗锯齿 / 缓存网络图片 / 标题栏透明 / 窗口透明仍是 `disabled`（标「暂不支持」），主题与主题包入口仍是占位。
> 由此设置中心 44→38、总计 269→263。

---

## 1. L1 骨架（11/11 ✅）

| 层级 | 节点 | 项数 | 已做 | 状态 | 实现位置 / 说明 |
|---|---|---:|---:|---|---|
| L1 | 主窗口 | 0 | — | ✅ | `#stage` 外壳 |
| L1 | 标题栏 | 6 | 6 | ✅ | `.window-bar` + `.window-controls`（另加自定义窗口必需的最大化 = 7 个可见按钮） |
| L1 | 侧边栏 | 5 | 5 | ✅ | `.nav-rail` 5 个 rail 按钮；下载中心已启用 |

## 2. 账户（22/22 ✅）

| 层级 | 节点 | 项数 | 已做 | 状态 | 实现位置 / 说明 |
|---|---|---:|---:|---|---|
| L2 | 账户 | 4 | 4 | ✅ | `stageAccount`：3 张登录方式卡 + `#accountList` 已保存账户 |
| L5 | 微软登录 | 3 | 3 | ✅ | `dlgMicrosoft`；`:216` 可点击面板 = **`#msaHelpPanel` 登录说明面板** |
| L5 | 添加离线账户 | 6 | 6 | ✅ | `dlgOffline`；`:606` = **`#offlineSkinPick` 皮肤选择入口**、`:574` = 皮肤子流程取消 |
| L5 | 正版登录对话框 | 2 | 2 | ✅ | 合并为 `#tabAuthlib` 页签，`#authlibDialogLogin` 承担"确定" |
| L5 | 添加认证服务器 | 5 | 5 | ✅ | `dlgServer`；清单的 2 个「取消」合并为 1 个常驻 `#serverDialogCancel` |
| L5 | 离线皮肤设置 | 2 | 2 | ✅ | `dlgSkin`：选择文件 / 模型 / 清除 / 预览 |

## 3. 游戏 / 实例详情（75/81 ⚠️）

| 层级 | 节点 | 项数 | 已做 | 状态 | 实现位置 / 说明 |
|---|---|---:|---:|---|---|
| L2 | 游戏（当前实例） | 2 | 1 | ⚠️ | 启动按钮（`#cta`）已通；**主视区与新闻栏仍为占位**（`news-item--placeholder` ×6） |
| L3 | 实例详情 | 38 | 38 | ✅ | `stageInstanceDetail`：7 页签 + 10 文件夹 chip + 设置表单 + 4 个导航项 + 5 项管理菜单（本轮补齐） |
| L3 | └ 游戏设置 | 0 | — | ✅ | `#detailSettingsForm` |
| L4 | └ 自动安装 | 1 | 1 | ✅ | `#detailInstallerList` |
| L4 | └ 模组 | 2 | 2 | ✅ | `data-detail-tab="mods"` + `instances:content-*` |
| L4 | └ 资源包 | 1 | 1 | ✅ | `data-detail-tab="resourcepacks"` |
| L4 | └ 世界 | 0 | — | ✅ | `data-detail-tab="worlds"` |
| L4 | └ 世界详情 | 5 | 5 | ✅ | `#worldCheats/#worldFeatures/#worldDifficulty/#worldLock/#worldGameMode` |
| L4 | └ 世界管理 | 19 | 19 | ✅ | `#worldBackup*` / `#worldDatapack*` / `#worldChunkbase` / 启动·脚本·导出·删除·复制·管理 |
| L4 | └ 投影 | 2 | 2 | ✅ | `data-detail-tab="schematics"` |
| L4 | └ 截图（第 7 页签） | 3 | 3 | ✅ | `data-detail-tab="screenshots"` + `dlgShot`：设为启动器背景 / 复制 / 确定 |
| L4 | └ 内容更新 | 5 | 0 | ⛔ | 无界面（AddonUpdatesPage） |
| L5 | 实例图标选择 | 3 | 3 | ✅ | `dlgIcon`：内置图标网格 / 选文件 / 重置 |

## 4. 实例管理（8/8 ✅）

| 层级 | 节点 | 项数 | 已做 | 状态 | 实现位置 / 说明 |
|---|---|---:|---:|---|---|
| L2 | 实例管理 | 3 | 3 | ✅ | `stageInstances`：修改 / 添加游戏文件夹 / 全局游戏设置 |
| L4 | 游戏目录管理 | 2 | 2 | ✅ | `stageGameDir`：相对路径开关 + 保存（`gamedirs:*`） |
| L4 | 实例右键菜单 | 1 | 1 | ✅ | 实现为 **10 项**菜单（详情/启动/测试/脚本/重命名/换图标/复制/删除/导出/文件夹） |
| L5 | 实例操作对话框 | 2 | 2 | ✅ | `dlgInstance`；「导出整合包」已启用并接到导出向导 |

## 5. 下载中心（26/26 ✅）

| 层级 | 节点 | 项数 | 已做 | 状态 | 实现位置 / 说明 |
|---|---|---:|---:|---|---|
| L2 | 下载 | 9 | 9 | ✅ | `stageDownload` + 6 个 `data-download-tab` |
| L3 | 游戏版本 | 4 | 4 | ✅ | 搜索 / 类型 / 刷新 / 版本卡网格 + `dlgInstall` |
| L4 | 安装向导 · 可选文件 | 3 | 3 | ✅ | `dlgPackFiles`；`#packOptional` 已启用（本轮） |
| L4 | 加载器版本选择 | 0 | — | ✅ | 实现位置在**新建实例**页：`#createLoader` / `#createLoaderVersion`（见 §2 偏差 1） |
| L4 | 可选安装器 | 0 | — | ➖ | 自动安装页仅说明 OptiFine/LiteLoader 禁用（设计决定） |
| L3 | 整合包 | 2 | 2 | ✅ | 安装 + 可选文件均已启用（本轮） |
| L4 | 整合包类型选择 | 1 | 1 | ✅ | `#packSources` 来源按钮组 |
| L4 | 整合包来源 | 0 | — | ✅ | Modrinth / CurseForge 切换 |
| L4 | 本地整合包 | 0 | — | ✅ | `#packPick`（`.zip/.mrpack`） |
| L3 | 内容列表（模组/资源/光影/世界） | 2 | 2 | ✅ | 三个 addon 页签：搜索 + 版本 + 加载器 + 排序 |
| L4 | 内容下载页 | 5 | 5 | ✅ | `dlgAddon`：版本列表 / 依赖 / 下载到本地 / 取消 / 确定 |
| — | 世界下载页签（清单外） | — | — | ⛔ | `data-addon-search="world"` 仍 `disabled`，不计入 284 项 |

## 6. 设置中心（38/47 ⚠️，3 项不做 + 4 项暂不支持）

| 层级 | 节点 | 项数 | 已做 | 状态 | 实现位置 / 说明 |
|---|---|---:|---:|---|---|
| L2 | 设置 | 12 | 12 | ✅ | `stageSettings`：6 个 `data-settings-tab` 齐全 |
| L3 | 游戏设置 | 5 | 5 | ✅ | **本轮补齐「预设」**：`#settingsPreset` + 新建 / 应用 / 删除；内存/窗口宽高/隔离策略/JVM 原有 |
| L3 | Java 管理 | 1 | 1 | ✅ | `#settingsJava` + `#settingsJavaScan` |
| L5 | 安装 Java | 1 | 1 | ✅ | `#settingsJavaInstall` → `dlgJavaDownload` → `java:install`（Adoptium Temurin） |
| L5 | 恢复 Java | 0 | — | ➖ | 空节点，无控件 |
| L5 | Java 下载提示 | 2 | 2 | ✅ | `dlgJavaDownload`：下载 / 取消（可选 8 / 17 / 21 / 25） |
| L3 | 通用设置 | 3 | 3 | ✅ | `#settingsLanguage` / `#settingsAprilFools` / `#settingsOpenLogs` |
| L3 | 个性化 | 11 | 5 | ⚠️ | ✅ 主题模式（跟随系统/浅/深，`#settingsThemeMode`）、色彩模式 + 自定义主色、导出主题快照（`#settingsThemeExport`）、背景加载方式、关闭动画；⛔ 主题 / 主题包入口仍是占位；⛔ 抗锯齿、缓存网络图片、标题栏透明、窗口透明保持 `disabled`（标「暂不支持」） |
| L4 | 主题包管理 | 3 | 0 | ➖ | 代码注释明确「这一层不做，但入口先占位」 |
| L3 | 下载设置 | 3 | 3 | ✅ | `#settingsVersionSource` / `#settingsDownloadSource` / `#settingsAddonSource` |
| L3 | 关于 | 4 | 4 | ✅ | `#settingsAboutVersion` / `#settingsOpenRepo` / `#settingsOpenLicense` |
| L4 | NBT 编辑器 | 2 | 2 | ✅ | 通用页「打开 NBT 编辑器」→ `dlgNbt`；`nbt.js` 全量读写，保存 / 取消 |

> 个性化之外还多了一套**壁纸系统**（`settingsWall*` + `wallpaper:list/pick/remove/open-folder`），属清单外新增（见 §3）。

## 7. 其他

| 层级 | 节点 | 项数 | 已做 | 状态 | 实现位置 / 说明 |
|---|---|---:|---:|---|---|
| L4 | 导出整合包向导 | 8 | 8 | ✅ | `dlgExport`：类型（CurseForge / Modrinth）→ 文件 → 信息（认证服务器 + 4 开关 + 导出）；`electron/modpack-export.js` |
| L5 | 全局弹窗 | 0 | — | ✅ | `askConfirm` / `askPrompt` / `runTask` + 日志 / 崩溃 / 游戏崩溃 / 预设 |
| L5 | 日志窗口 | 5 | 5 | ✅ | `dlgLog`：自动滚动 / 导出 / 结束游戏进程 / 导出运行栈 / 清除 |
| L5 | 崩溃窗口 | 1 | 1 | ✅ | `dlgCrash`：打开日志文件夹（主进程日志落盘到 `<userData>/logs/`） |
| L5 | 游戏崩溃窗口 | 3 | 3 | ✅ | `dlgGameCrash`：导出游戏崩溃信息 / 日志 / 帮助 |
| L5 | 游戏设置预设 | 1 | 1 | ✅ | 设置 → 游戏设置 →「新建预设」 |
| L5 | 安装项 | 1 | 1 | ✅ | `dlgInstall` / `dlgTask` |
| 共享 | 共享组件 / 框架 | 70 | 64 | ✅ | 明细见 §9 |

---

## §2 实现与基线偏差（清单描述已过时）

| # | 清单原描述 | 实现实际情况 | 处理 |
|---|---|---|---|
| 1 | 「加载器版本选择」在 `下载 → 游戏版本` 下 | 上移到**新建实例**页（`#createLoader` + `#createLoaderVersion`），走 `loaders:list` | 清单 `dl-loader` 节点保留，标注迁移 |
| 2 | `CreateAccountPane:606` 记为"（运行时赋值）可点击面板" | 实为**离线页签内嵌皮肤入口**；`:574` 是其子流程取消 | 已回填中文文案 |
| 3 | `MicrosoftAccountLoginPane:216` 记为"（运行时赋值）可点击面板" | 实为**登录说明面板** `#msaHelpPanel` | 已回填中文文案 |
| 4 | 实例详情「7 页签」 | 第 7 个页签 = **截图**，按静态页签实现（游戏设置 / 自动安装 / 模组 / 资源包 / 世界 / 截图 / 原理图） | ✅ 已对齐 |
| 5 | 添加认证服务器「5 按钮」含 2 个取消 | 实现合并为 1 个常驻取消 | 计 5/5 |
| 6 | 游戏设置 5 项 = 预设/默认隔离策略/版本隔离/2 运行时 | 实现 = 预设（本轮补齐）/ 内存 / 窗口宽高 / 隔离策略 / JVM | ✅ 已补齐，5/5 |
| 7 | 个性化 11 项 | ~~实现仅 1 项~~ → ~~11/11~~ → **5/11**（主题模式 / 色彩模式 / 导出主题 / 背景加载 / 关闭动画）；4 项标「暂不支持」、2 项仍是占位 | ⚠️ 见 §0 主题轮修正 |

## §3 清单外新增（已实现，基线里没有）

- **新建实例页**（`stageCreate`）：版本类型/版本/加载器/加载器版本/实例名 + 安装进度
- **壁纸系统**：`settingsWallMode / WallKind / WallPickImage / WallPickVideo / WallPip / WallFit / WallBlur / WallDim / WallPolicy` + `wallpaper:*` 5 条通道
- **整合包拖拽导入**、`.mrpack` / `manifest.json` 双格式
- **世界备份 / 数据包管理 / chunkbase 地图**
- **下载中心 6 页签完整结构**
- **实例行 ⋯ 菜单 10 项**
- **通用组件层**：`askPrompt` / `runTask` / `createList` / `createTabs` / `ui:context-menu`
- **安全层**：`path-guard.js`、`modpack-guard.js`、`wallpaper-check.js`、`docs/security/` 审计工具链
- **启动参数规格/脚本** `launch-spec.js` / `launch-script.js`
- **本轮新增**：启动器日志落盘（`app-log.js`）、运行栈导出、截图页签与查看器、实例维护（清理 / 资源 / 库）、
  更新整合包（装到临时实例再合并）、导出整合包向导、Adoptium Java 安装、NBT 编辑器、游戏设置预设
- **主题引擎**：`data-theme` + `--accent`/`--accent-rgb` 变量化（252 处收敛）、主题模式 / 色彩模式 / 导出主题快照（见 §10.1）
- **扫描缓存可清理**：`instances:scan-cache` / `-clear` / `-forget` + 实例面板按钮；`gamedirs:remove` 顺带剔缓存（见 §10.1）
- **更新整合包安全层**：`instance-merge.js` 影子目录 + 两次原子 rename + 备份 + 回滚 + 启动自愈（见 §10.2 / §10.5）
- **下载完整性**：`Http.BadContentException` 坏内容快速换源、安装器 jar 的 `.sha1` 探测 + zip 校验、Temurin SHA-256 校验（见 §11）

## §4 未做清单（8 项实操 + 13 项不做 = 21 项）

| 块 | 项数 | 具体 | 备注 |
|---|---:|---|---|
| 内容更新（AddonUpdatesPage） | 5 | 导出 / 更新 / 取消 / 列表项 / 确定 | 需"检查更新"比对逻辑（Modrinth 版本匹配） |
| 共享组件（§7 C 组） | 2 | HTMLRenderer 2（待定） | 工具栏基座已补；4 项「不做」另计 |
| 主页主视觉 / 新闻 | 1 | 3D 展示 / 新闻 API | 仍是 placeholder |
| 个性化（§6） | 6 | 主题 / 主题包入口（等主题引擎，2 项）；抗锯齿 / 缓存网络图片 / 标题栏透明 / 窗口透明（`disabled` 暂不支持，4 项） | 4 项 ➖ 暂不支持 + 2 项 ⛔ 等主题引擎 |
| 主题包管理 | 3 | 列表项 / 确定 / 导入项 | **➖ 设计决定不做**（没有主题引擎，占位保留） |

**总计：5（内容更新）+ 2（HTMLRenderer）+ 1（主页）= 8 项实操；+ 13 项「不做」（个性化 4 暂不支持 + 个性化 2 等引擎 + 主题包 3 + 共享 4）= 21 项剩余。**

## §5 现存 `disabled` / 占位入口

1. 下载 → 世界 →「搜索」`[data-addon-search="world"]`（清单外项：没有可用的在线世界源）
2. 模组 / 资源包 / 原理图 →「检查更新」虚线占位（内容更新未做）
3. 设置 → 外观 → 6 个主题相关控件 + 主题包管理（设计决定，占位保留）
4. 主页新闻 →「接入后可用」

> 已消除：整合包「可选文件」`#packOptional`、设置「安装 Java」、实例菜单 / 实例对话框的「导出整合包」。

## §6 基线文件口径问题

1. ~~`ui-tree-controls.html` 的「含子页」聚合 bug~~ → **已修复**：全部节点已正确（实例管理 8、下载 26、实例详情 76、设置 47、游戏 81、侧边栏 189、主窗口 284），「直接」相加 = 284。
2. `ui-inventory.md` 的 `#` 是原始扫描 ID（乱序），`ui-inventory.csv` 的 `序号` 是 1–284 重排号，**不能按数字对照**（靠「文件:行」对齐）。
3. `ui-inventory.csv` 有 2 条记录内嵌换行（序号 156、163），**不能用按行 split 解析**。
4. CSV 带 UTF-8 BOM；md/html 无 BOM。

---

## §7 共享组件逐项

### A 组 · 文本编辑右键菜单（7/7 ✅）

| 位置 | 项 | 状态 | 实现 |
|---|---|---|---|
| `FXUtils.java:1456` | 撤销 | ✅ | `ui:context-menu` + 主进程 `Menu.popup`，编辑动作走 Chromium 原生 `role` |
| `:1457` | 重做 | ✅ | 同上 |
| `:1458` | 剪切 | ✅ | 未选中 / 只读 / 密码框置灰 |
| `:1459` | 复制 | ✅ | 未选中 / 密码框置灰 |
| `:1460` | 粘贴 | ✅ | 只读 / 密码框置灰 |
| `:1461` | 删除 | ✅ | 未选中 / 只读置灰 |
| `:1462` | 全选 | ✅ | 所有输入框可用 |

（不用 `document.execCommand`：中文输入法的撤销栈由 Chromium 原生编辑命令维护。）

### B 组 · 通用对话框（3/3 ✅）

| 位置 | 项 | 状态 | 实现 |
|---|---|---|---|
| `InputDialogPane.java:49` | 确定 | ✅ | `askPrompt()`，`Promise<string\|null>` |
| `InputDialogPane.java:53` | 取消 | ✅ | 取消 / Esc / 关闭均 resolve `null`；空值框内提示 |
| `TaskExecutorDialogPane.java:66` | 取消 | ✅ | `runTask()` + `dlgTask`；`task:cancel` abort，子进程被 kill |

调用点：`askPrompt` = 实例重命名 / 复制实例 / 世界重命名；`runTask` = 安装实例（原版/加载器）/ 安装整合包。

### C 组 · 列表 / 导航基座（10 项）

| 位置 | 项 | 状态 | 说明 |
|---|---|---|---|
| `AdvancedListBox.java:57` | 列表项基座 | ✅ | `createList()`（容器/行渲染/选中/空态/计数） |
| `:66/:67/:70` | 导航项 | ➖ | 侧边栏 5 个 rail 已有统一 `aria-*`，未再抽类 |
| `:85/:95` | 导航页签 | ✅ | `createTabs()`（5 处调用：设置/详情/世界/下载…） |
| `MDListCell.java:87` | 可点击面板 | ✅ | 行/菜单项用 `<button>`，键盘行为由浏览器提供 |
| `ToolbarListPageSkin.java:71/:80` | 工具栏左右按钮 | ✅ | `createToolbar()`（`renderer.js:1819`）：搜索（`liveSearch` / `enterSearch` / `debounce`）、筛选 `filters`、动作 `actions`（含 `when` 门控、`busyClass`）、计数 `setCount`、`setBusy`、`reset`；已迁移 4 处：实例列表 867 / 世界 8589 / 下载-游戏版本 10081 / 模组·资源包·光影 10756 |
| `SpinnerPane.java:203` | 数字微调 | ➖ | 用 `<input type="number">` 代替 |

### D 组 · 菜单项基座（2 项，已覆盖）

实例菜单 10 项、世界菜单 6 项共用 `.ctx-menu` + `role="menuitem"`；未单独抽类（收益低于回归风险）。

### E 组 · 明确不做（设计决定）

| 位置 | 项 | 决定 |
|---|---|---|
| `FontComboBox.java:42` | 字体下拉 | **不做** |
| `MenuUpDownButton.java:71` | 上下移 | **不做**（镜像源 UI 本版没做） |
| `SpinnerPane.java:203` | 数字微调 | **不做** |
| `LineInheritableToggleButton.java:50` | 三态继承开关 | **不做**（`#detailSettingsReset` 已覆盖语义） |
| `HTMLRenderer.java:167/:246` | HTML 渲染 | **待定**（新闻/更新日志接 API 时再做） |

---

## §8 本轮完成：全局弹窗 / 实例详情收尾 / 导出向导 / 设置收尾（37 项）

> 2026-11-02 21:10 核对。所有控件均已接线，不再有 `disabled` 入口（除设计决定不做的主题包与清单外的世界下载）。

| 节点 | 实现 | 位置 |
|---|---|---|
| 日志窗口 5 | 自动滚动开关（`aria-checked`）/ 导出（另存 + 定位）/ 结束游戏进程（`launcher:stop`，只有运行时可用）/ 导出运行栈（jstack，缺失时退回启动器侧信息）/ 清除（只清视图） | `dlgLog`，`logs:tail`、`logs:export`、`logs:dump`、`logs:open-folder` |
| 崩溃窗口 1 | 打开日志文件夹；主进程 `console.*` / `uncaughtException` 落盘到 `<userData>/logs/launcher-*.log` | `dlgCrash`，`app-log.js`，`shell:open-logs` |
| 游戏崩溃窗口 3 | 导出游戏崩溃信息（崩溃报告 + 日志尾部打包）/ 日志（切到日志窗口）/ 帮助（外链 troubleshooting） | `dlgGameCrash`，`crash:export`，`launcher:launch-progress` 的 `exit` 事件 |
| 游戏设置预设 1 | 新建 / 应用 / 删除，存 `launcher-settings.json` 的 `presets` | 设置 → 游戏设置，`normalizePresets()` |
| 实例详情导航项 3 | 更新整合包（新装临时实例 → 合并进原实例）/ 浏览（文件夹快捷菜单）/ 管理（5 项维护菜单）；测试游戏沿用同一导航栏 | `#detailUpdatePack/#detailBrowse/#detailManage/#detailTestLaunch`，`instances:merge-pack`、`instances:maintenance` |
| 实例详情菜单 5 | 截图管理（切页签）/ 更新游戏资源文件（`--assets-only --verify`）/ 删除所有资源文件 / 删除所有库文件 / 清理游戏文件夹 | `DETAIL_MANAGE_ITEMS` |
| 第 7 页签 3 | 截图页签 + 查看器：设为启动器背景 / 复制到剪贴板 / 确定 | `data-detail-tab="screenshots"`、`dlgShot`、`instances:screenshots`、`screenshots:copy`、`screenshots:set-wallpaper` |
| 导出整合包 2 处 | 实例菜单与实例操作对话框都打开同一个向导；向导 3 步 / 8 项全部可用 | `dlgExport`、`modpack:scan`、`modpack:export`、`modpack-export.js` |
| 设置收尾 6 | 安装 Java（Adoptium Temurin，可取消）/ Java 下载提示（下载 / 取消）/ NBT 编辑器（保存 / 取消） | `dlgJavaDownload`、`java:install`、`java-install.js`；`dlgNbt`、`nbt:pick`、`nbt:save`、`nbt-editor.js` |

**实现口径说明**：
1. 日志实时性：主进程把 `launcher:launch-progress` 的 `output` 事件原样转发，日志窗口打开时先 `logs:tail` 读历史、之后按事件续写，不再单独开一条流。
2. 崩溃检测：`exit` 事件里带上 `stopped`（手动结束不算崩溃）与本次启动后新出现的 `crash-reports/*.txt`；只有非 0 退出码才弹游戏崩溃窗口。
3. 导出格式：CurseForge（`manifest.json`）与 Modrinth（`modrinth.index.json`），内容统一放 `overrides/`；不生成需要联网比对的 `files` 列表，避免导出包在别的启动器里装不上。
4. 更新整合包：复用 `downloads:install-pack` 装到同游戏目录下的临时实例（`update-<stamp>`），再按目录合并覆盖，最后删除临时实例；外部目录实例也能更新（`install-pack` 现在接受已登记的 `gameDir`）。
5. 主题包管理 3 项仍为 ➖ 不做：没有主题引擎，保留占位入口。

---

## §9 后续待办（2026-11-02 21:30 记录，暂不做）

> 产品决定：除「共享工具栏基座」（已完成）外，其余**先记录不实现**。实现方自行评估优先级。

### 9.1 清单内剩余（8 项）

| 项 | 数量 | 说明 |
|---|---:|---|
| 内容更新 AddonUpdatesPage | 5 | 导出 / 更新 / 取消 / 列表项 / 确定；需 Modrinth 版本比对逻辑，UI 侧已有「检查更新」虚线占位 |
| HTMLRenderer | 2 | 待定，等新闻 / 更新日志接富文本 API |
| 主页主视觉 / 新闻 | 1 | 仍是 `placeholder`×6 + 「接入后可用」disabled |

> ✅ **已完成**：共享工具栏基座 2 项 —— `createToolbar()`（`renderer.js:1819`）+ 4 处迁移（实例列表 / 世界 / 下载-游戏版本 / 模组·资源包·光影）。验证：`node --check` 通过、独立单测 15/15、无残留内联监听、`index.html` 未改。

### 9.2 清单外缺口（6 条，按价值排序）

| # | 缺口 | 现状证据 | 建议 |
|---|---|---|---|
| 1 | 世界在线下载源 | 下载 → 世界页签 `[data-addon-search="world"]` 仍 `disabled` | 先定数据源（Modrinth 无 world 分类，可能需 CurseForge） |
| 2 | 启动器自我更新 | 只有 `app:info`；`检查更新` / `update-available` 引用为 0 | 发布前必须有，否则线上问题只能让用户重下 |
| 3 | 多语言 | `#settingsLanguage` 只有「简体中文」一个 option；`i18n` / `locale` 引用为 0 | 控件已计完成，功能是空壳 |
| 4 | 恢复 Java | 树里是 0 项节点，代码里 `恢复 Java` 引用为 0 | 用户选错 java 路径后无法一键回默认 |
| 5 | 主题引擎 | 主题包管理 3 项占位 | 属"主动砍掉的真功能"，做的话要连 9.1 的 HTMLRenderer 一起评估 |
| 6 | Electron 侧零测试 | `electron/` 下无 test/spec；只有 `mcdl/tests` 两个 Java 回归测试 | `renderer.js` 已 375 KB 单文件，建议至少在基座回迁时补 1~2 个冒烟脚本 |

### 9.3 技术债提示

`renderer.js`（约 380 KB）与 `main.js`（约 170 KB）均为单文件。共享基座（`createList` / `createTabs` / `askPrompt` / `runTask` / `createToolbar`）已就位，但 **25 个历史 `render*` 函数尚未回迁**；建议新页面一律用基座，老页面只在修 bug 时顺带迁移，不做专项大面积回迁。

---

## §10 2026-11-02 第三批：主题 / 测试 / Java 恢复 / 缓存清理 / 合并安全

> 这一批 5 项由子代理并行完成，均经主会话独立复核（`node --check` + 全量测试 + 人工破坏性验证）。

### 10.1 完成清单

| # | 项 | 交付 | 复核结果 |
|---|---|---|---|
| 1 | **主题引擎** | 主题模式（跟随系统/浅/深）+ 色彩模式（自定义主色）+ 导出主题快照；`data-theme` 写在 `<html>`，252 处 `rgba(159,208,255,α)` 收敛为 `var(--accent-rgb)` | 个性化 2/11 → **5/11**；`node --check` 通过；CSS 括号配平 889/889 |
| 2 | **Electron 测试基建** | `electron/tests/` 12 个文件 + `npm test`；覆盖 path-guard / modpack-guard / version-manifest / instance-store / nbt-editor / launch-spec / modpack-export / java-install / modrinth-download / game-directories / instance-isolation / smoke | **284 / 284 绿**（沙箱内因管道 stdio 会挂 1 条 `game-window`，全权限下通过，属环境性；见 10.4 #5） |
| 3 | **恢复 Java** | `#settingsJavaReset`「恢复默认」；`javaPath` 为空时置灰、扫描不到时红色高亮并说明「可能已被卸载或移动」 | id 唯一（437 个无重复）；仅改全局 `javaPath`，不动实例级 |
| 4 | **扫描缓存可清理**（清单外） | 新通道 `instances:scan-cache` / `scan-cache-clear`；实例面板「清理缓存 (N)」按钮；`gamedirs:remove` 顺带从缓存剔除 | main / preload / renderer 三处在位 |
| 5 | **更新整合包安全改造**（清单外，**数据安全**） | 新模块 `instance-merge.js`：影子目录 + 两次原子 rename + 自动备份 + 失败/取消回滚 + `instances:merge-undo` 撤销 | 见 10.2 |

### 10.2 合并安全：修掉的真实缺陷

修复前 `main.js` 的 `copyTreeInto()` 用 `fs.copyFile(from, to)` **无条件覆盖**用户实例文件，无备份、无回滚；游戏运行中 / 磁盘满 / 取消 / 断电都会留下**半新半旧**的实例。这与 PCL2 那次「整合包覆盖损坏用户文件」属同一类缺陷（业界最严重的一档）。

修复后：

```
1) 复制 target → versions/.<name>.mcdl-merge-<token>.tmp   （同分区）
2) staging 覆盖进 tmp（跳过版本 json/jar）
3) rename(target → .old)；rename(tmp → target)             （两次原子 rename）
```

- **两次 rename 之前，目标实例一个字节都没被写过** → 结构上不存在半覆盖；
- 动手前把将被覆盖的文件备份到 `<userData>/instance-merge-backups/<实例名-sha1>/<时间戳>/`；
- 失败/取消自动回滚；回滚失败给出 `.old` 绝对路径；
- 游戏运行中直接拒绝（`assertNoActiveLaunch`）；
- UI 显示「覆盖 N / 新增 M / 跳过 J + 备份路径」，并提供「撤销本次更新」。

**人工破坏性验证**（主会话独立执行，13/13 通过）：第 2 个文件复制前抛错 → 目标 `a.txt`/`b.txt` 仍是旧值、`.tmp`/`.old` 零残留、实例目录完好；正常合并后无关文件保留、staging 版本 json 未被带入；`restoreFromBackup` 能还原旧内容。

### 10.3 顺带修掉的 bug

- **NBT `long` 精度**：`parseValue('long', ...)` 经 `Number` 中转，超过 2^53 静默丢精度 → 在 NBT 编辑器改 `RandomSeed` 会改掉世界种子。改为正则校验 + `BigInt` 直解析 + 64 位范围校验，并补 2 条边界用例（`2^53±1`、`±2^63`、`1e5`/`12.5`/`0x10` 必须被拒）。

### 10.4 已知问题

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| 1 | 主题存在 **localStorage**（`mcdl.theme.v1`），因 `main.js` 的 `normalizeExtraSettings` 白名单不含 `themeMode`/`colorStyle`/`accentColor`，未知键会被丢弃 | 主题设置不随 `settings.json` 备份/迁移 | ⛔ 未修（渲染层已做自动探测，主进程补 3 个键后即可切换） |
| 2 | 浅色主题是 **`filter: invert(1) hue-rotate(180deg)`** 反相实现（约 300 处硬编码深色） | 图片双重反相有轻微色偏；浅色下壁纸"压暗"变"提亮"；`backdrop-filter` 未验证。已补 `color-scheme: light` 修原生下拉仍是深色 | ⛔ 未修（长期应收敛为变量覆盖） |
| 3 | 合并备份只增不减 | 磁盘随更新累积 | ✅ **已修**（见 10.5） |
| 4 | 合并 `kill -9` 落在两次 rename 之间 | 实例暂时从列表消失，数据在 `.old` | ✅ **已修**（见 10.5） |
| 5 | `tests/game-window.test.js` 在 DSH 沙箱必然 15s 超时 | `game-window.js` 用 `spawn(powershell, {stdio:['ignore','pipe','ignore']})` 抓 stdout，沙箱禁止管道 stdio | ➖ 非代码问题（本机终端可正常跑） |

### 10.5 收尾加固：启动自愈 + 备份保留

**自愈**：`recoverInterruptedMerges({ versionsRoot })`（`instance-merge.js:639`），在 `app.whenReady()` 里、`createWindow()` 之前 `await`，保证渲染层第一次拿到的实例列表已是恢复后的状态。

| 现场 | 处理 |
|---|---|
| `.old` 在、目标缺失 | `rename(.old → 目标)` 让实例回来；同批 `.tmp` 改名成隐藏的 `…mcdl-merge-lost-<时间戳>` 留档（`.` 前缀继续被实例扫描跳过） |
| `.old` 在、目标也在 | 只删 `.old`（上一版副本），目标内容不动 |
| 只有 `.tmp`、目标在 | 删半成品 |
| 只有 `.tmp`、目标缺失 | **不改名不删除**（无法判断完整性，宁可让用户按日志排查） |

安全边界：只扫 `versions/` 直接子项、父目录 basename 必须是 `versions`、只认 `MERGE_LEFTOVER_PATTERN`、符号链接不碰、全程 try/catch 不阻塞启动。

**保留**：`pruneMergedBackups({ backupRoot, keep })`，`KEEP_BACKUPS = 3`。删除需同时满足三条（是目录 / 目录名匹配 ISO 时间戳 / 有可解析的 `manifest.json`），否则跳过；`keep` 为 `null`/`NaN`/负数退回默认 3，只有显式 `0` 才全删。合并成功后自动清理，启动时另有一次性后台清理。

**人工验证**（主会话独立执行，19/19 通过）：四类现场各一例 + 不碰无关目录 + 非 `versions` 父目录整次放弃；备份保 5 份 → 清理后恰留最新 3 份、无 manifest 目录与用户自建目录均未被删、`keep=null/-1` 不误删。

> 小瑕疵（不影响功能）：残留目录名是 `.<实例名>..mcdl-merge-<token>.old`，中间有双点（`MERGE_MARKER` 自带前导点又拼了一次）。消费者与生产者用同一模板所以功能正确，仅资源管理器里看着奇怪，可后续统一。

---

## §11 2026-11-02 第四批：下载完整性（镜像不一致防护）

> 起因：对照 HMCL 的「镜像源与官方源不一致 → 装到一半崩、报看不懂的错误」问题做的专项核查。
> 结论：本项目的**架构层已经不会犯这个错**（候选地址永远带官方兜底 + 下载即校验 SHA-1 + 失败自动换源），但有 3 处「裸奔」的下载点被补齐。

### 11.1 核查结论：已经做对的部分

| 机制 | 位置 | 说明 |
|---|---|---|
| 候选列表永远带官方兜底 | `Sources.java`（`assetCandidates` / `fileCandidates` / `mavenCandidates` / `versionJsonCandidates`） | 镜像排第一、官方排第二，`dedupe` 去重 |
| 下载即校验 + 自动换源 | `Http.download` | SHA-1 / 大小不符 → 删 `.part` → 换下一个 URL |
| 版本 JSON 被篡改有专用报错 | `Installer.java:324` | 「版本 JSON 的 SHA-1 不符（可能被镜像篡改或缓存过期），请换下载源重试」 |
| 资源按哈希寻址 | `Installer.java:429` | `objects/xx/<hash>` |
| 安装器不会永久卡死 | `Loaders.java:702` | `waitFor(30, MINUTES)` + `destroyForcibly` |
| 整合包失败可精确重试 | `ImportState` + `Modpack` | 失败项保留 `path/sha1/size/url` |

### 11.2 补掉的 3 个裸奔点

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | `Http` 对「内容错误」太宽容：SHA-1/大小不符仍会在**同一 URL** 重试满 3 次才换源（每次可能 60s 超时 + 退避）＝用户体感"卡很久" | 新增 `Http.BadContentException`；`download()` 捕获后**立即 break 换下一个地址**，不再消耗重试预算。连接失败 / 5xx / 416 / 超时仍是 `RetryableException` 原样重试。公开签名未变 |
| 2 | **Forge / NeoForge 安装器 jar 完全不校验**（`Loaders.java:574`、`Modpack.java:297` 都传 `null, -1`） | 新增 `Loaders.downloadInstaller()`：逐候选 ①`requireMavenSha1()`（GET `<url>.sha1`，首行 40 位 hex 才采用；**拿不到即判该候选失败**，见 §12.1）②单地址下载 ③`verifyInstallerJar()`（`PK\x03\x04`/`PK\x05\x06` + `ZipFile` 可打开且非空）④原子改名；任一环失败换下一个候选，全失败抛最后异常。安装器坏内容的文案：`安装器下载内容不是有效的 jar（来源：<url> 或镜像）。请换下载源重试，或检查网络代理是否劫持了下载。` |
| 3 | **Temurin JDK 下载零校验**（`java-install.js` 直接 fetch → tar） | 改走 `/v3/assets/latest` 取 `link` + `checksum` + `size`；下载后**解压前**先比 size、再用 `createHash('sha256')` 流式比哈希；不符即删文件并抛可读中文错误。assets 不可用时降级旧直链，但**明确标记「本次下载未做校验」**（日志 + 进度文案，不静默） |

附带：`Loaders` 的 natives 分支现在从 `lib.nativesInfo.size` 取期望大小传给 `Http.download`（原本传 `-1`）。

### 11.3 验证（主会话独立复核）

| 项 | 结果 |
|---|---|
| `javac --release 17` 全量 21 个源文件 | 0 error |
| 新 `mcdl.jar` | 211030 字节，SHA-256 `816E7291…74D11A1`，含 `Http$BadContentException`（73 条目）；**已覆盖 `mcdl/mcdl.jar`** |
| `java -jar mcdl/mcdl.jar --help` | exit 0 |
| `java -jar mcdl/mcdl.jar --list` | 正常（实测自动测速：官方 573 ms / BMCLAPI 1093 ms → 选官方） |
| 换源语义（子代理自写 `HttpSwitchTest`） | 18 项断言 PASS，含「坏内容只请求 1 次即换源」「`.sha1` 404 时降级」「全坏时不留下半截文件」 |
| `mcdl/tests` 三个类 | ImportStateStressTest / PasteRegressionTest / FailureInstallTest 全 PASS |
| Electron 全量测试 | **270 / 270 pass**（沙箱内曾因管道 stdio 失败 1 条，全权限下通过，确认为环境性） |
| 残留 `null, -1` | 仅 `ModpackLink.java:97`（直链整合包，下载前无哈希可用，下载后另算 SHA-1） |

### 11.4 剩余风险

| 风险 | 说明 | 建议 |
|---|---|---|
| `.sha1` 探测是串行的 | 每个候选一次 `getRawText`（40s 超时 × 2），最坏多等约 80s 才降级；Loaders 走 BMCLAPI 优先基本无感，`Modpack` 在 AUTO 源下若官方排前面会慢一轮 | 可给探测加 10s 上限（需 `Http` 增加带超时的文本读取重载） |
| 换源语义变严 | 「大小不符」现在删 `.part` 并立刻换源，不再靠 Range 续传修复截断；最坏多下一次 | 取舍：宁可重下，不把错误内容拼进文件。真截断在 JDK `HttpClient` 上通常是 `IOException`（仍走可重试 + 保留断点） |
| 自解压式安装器会被拦 | zip 魔数校验只认标准 jar | Forge/NeoForge 各版本（含 1.7.10 老 Swing 安装器）都是标准 zip，暂未见误杀 |

> 对照结论：HMCL 那类「镜像 JSON 过期 / 安装器不同步 → 校验失败或缺依赖 → 卡半小时后 NPE」在本项目中对应的三条防线（候选含官方、下载即校验、坏内容快速换源）现已全部到位，且错误文案都指向「换下载源重试」。


---

## §12 2026-11-02 第五批：杀软误报面收敛（安装器落点 / 强制哈希 / 镜像 https）

> 起因：对照 PCL2「更新器被 Defender 秒删 → 启动器消失」的案例做同类风险排查。
> 结论：本项目**没有自更新机制**（`electron-updater`/`autoUpdater` 引用数为 0），所以该剧本不成立；但「下载二进制 → 落临时目录 → 静默执行」这个被 AV 盯上的行为组合确实存在，本批把它收敛掉。

### 12.1 P0-1 安装器不再写 %TEMP%

| 项 | 改动 |
|---|---|
| 落点 | `LauncherDirs.cacheDir()` = `%USERPROFILE%\.mcdl\cache`，`installerCacheDir()` = 其下 `installers`（与 `sources.json`、`curseforge.key`、`dialog-error.log` 同一套 `~/.mcdl` 约定，无第二套目录） |
| 命名 | `newInstallerJar(kind)` → `createTempFile(dir, "mcdl-<kind>-", ".jar")`，文件名唯一 |
| 清理 | `Loaders` 与 `Modpack` 两处 `finally` 均 `deleteIfExists`（正常/异常/取消）；删不掉只吞异常，不掩盖原始错误 |
| 过期清扫 | `Main.main` 启动时 `pruneInstallerCache(ofDays(7))`，只删 `*.jar` / `*.jar.dl` / `*.jar.part` 中 mtime 超 7 天的普通文件；任何异常全吞，不影响启动（GUI 与 CLI 共用此入口） |

`createTempFile` 自查：安装器路径上已无；残留仅 `ImportState.java`（实例目录内导入状态）与 `NativeDialog.java`（PowerShell 脚本）。

### 12.2 P0-2 `.sha1` 强制（取消降级）

`requireMavenSha1()` 包住 `probeMavenSha1()`：探测返回 null → 抛

> 无法校验安装器完整性：`<url>` 未提供 .sha1。请换个下载源或稍后重试。

- 哈希不符 / 内容不合法 → 仍换下一个候选（保留原行为），全失败才抛错；
- 执行前二次校验：`Loaders`、`Modpack` 两处 `ProcessBuilder` 之前都再 `verifyInstallerJar`；
- Fabric / Quilt 走 meta profile 的路径未动。

**行为变更**（从「能装但不校验」变成「直接失败」）：候选源 404/超时/返回 HTML → 该候选失败；自定义 https 镜像只镜像 jar 不镜像 `.sha1` → 该候选不可用；代理剥离 `.sha1` 或重定向到登录页 → 失败；`.sha1` 不是 40 位 hex → 失败；镜像 jar 已更新但 `.sha1` 是旧值 → 哈希不符失败（**以前会照装**）；Forge 1.7.10/1.12.2 老安装器（实为本地解包、不执行）同样要求 `.sha1`（偏严）。

**已知取舍**：Forge/NeoForge 候选顺序是 `[BMCLAPI /maven, 官方 maven]`。若 BMCLAPI 不代理 `.sha1` 且官方不可达（国内常见），安装会失败。**未实现「镜像下 jar + 官方取 .sha1」的跨源回退** —— 这是后续首选改进（哈希只要来自可信源，jar 从哪下都行）。

### 12.3 P1 自定义镜像只许 https

`Sources.normalizeBase` 只接受 `https://`，回环例外（`http://localhost`、`127.0.0.1`、`127.*`、`[::1]`）；错误文案改为「镜像地址必须以 https:// 开头（本机调试可用 http://127.0.0.1 或 http://localhost）」。`loadCustomMirrors` 走同一校验：旧 `sources.json` 里的 http 公网镜像被跳过并打一行 stderr，不崩、不清空列表。

### 12.4 构建链路修复（顺带）

`mcdl/build.ps1` 有两个坑，都已修：

1. **javac 的提示会中断构建**：`$ErrorActionPreference='Stop'` 下，javac 把「使用了未经检查或不安全的操作」写到 stderr，PowerShell 当成终止错误 → 编译成功却在打包前 `throw`。现改为只在 javac 调用期间 `Continue`，单独判 `$LASTEXITCODE`。
2. **`.ps1` 必须带 UTF-8 BOM**：Windows PowerShell 5.1 会把无 BOM 的脚本按 ANSI 解析，中文注释/字符串里的全角括号会把引号吃掉，导致整段语法崩。改动脚本后请确认前 3 字节是 `EF BB BF`。

### 12.5 验证

| 项 | 结果 |
|---|---|
| `mcdl/build.ps1` 全量重建（javac 21 文件 → jar → csc） | ✅ 退出码 0 |
| `mcdl/mcdl.jar` | ✅ 212682 字节 / 73 条目，**同时含** `Http$BadContentException`（§11）与 `requireMavenSha1`（§12.2） |
| `java -jar mcdl.jar --version` / `--help` / `--list-dirs` | ✅ `MCDL 1.0.8`，退出码 0 |
| Electron 全量测试 | ✅ **284 / 284 pass** |
| 改动文件语法 | ✅ `main.js` / `preload.js` / `renderer.js` / `java-install.js` / `modrinth.js` 全 `node --check` 通过 |
| 安装器行为冒烟（代理用本地 HttpServer 对成品 jar 跑） | 15 项 PASS：http 镜像被拒 / https 接受 / 回环接受 / 旧配置 http 条目被跳过 / 缓存落点与前缀 / 9 天前 jar 被清扫 / 无 `.sha1` 抛错 / 哈希不符抛错 / 正确哈希下载成功 |

### 12.6 剩余风险（P2）

| 项 | 说明 | 状态 |
|---|---|---|
| **`McdlDialog.exe` 收敛** | 已彻底删除：`NativeDialog.java` 702→约 440 行纯 Java（`JFileChooser` 选文件/选目录；`Desktop.open` 失败退 `explorer.exe`），`build.ps1` / `build.bat` 的 `csc` 步骤移除，`mcdl/native/McdlDialog.cs` 与 `mcdl/McdlDialog.exe` 删除；README 结构树、`.gitignore` 同步清理 | ✅ **已完成**（见 12.7） |
| 代码签名 | 全仓仍无签名（Electron 主程序与 `mcdl.jar` 皆未签） | ⛔ 待定（需证书） |
| 固定哈希白名单 | 现在每次都向 maven 要 `.sha1` | ⛔ 未做 |
| 行为簇 | 主进程仍会调 `whoami.exe /groups`（完整性探测）、`tar.exe`（解压） | ➖ 暂留（单个合理） |

### 12.7 `McdlDialog.exe` 收敛（2026-11-03 00:05）

**动机**：它是构建时用 `csc.exe` 现编的 12 KB **未签名原生 exe**，且被主进程反复拉起 —— 杀软启发式里「新鲜、无签名、被拉起的小 exe」是显眼特征。

**关键事实**：它**只被 mcdl 自己的 Swing GUI 使用**（`MainWindow.java:1053 / 1773 / 1842`）；Electron 前端零引用（走 `gamedirs:pick` → `dialog.showOpenDialog`）。所以收敛不影响主产品。

| 项 | 变化 |
|---|---|
| `NativeDialog.java` | 702 → 约 440 行纯 Java。删掉内嵌 C# 源码、`-EncodedCommand` PowerShell 回退、`helperPath()` 探测、静态初始化块与 shutdown hook；`openFile`/`openFolder` 走 `JFileChooser`（headless 返回 null + `lastError`），`openWithHelper` 走 `Desktop.open` → `explorer.exe` 兜底 |
| 对外 API | 未变（`MainWindow` 三处调用点一行未改），仅失败提示里去掉 `McdlDialog.exe` |
| 构建 | `build.ps1` 与 `build.bat` 的 `csc` 步骤移除，现在只有 `javac + jar` |
| 删除 | `mcdl/native/McdlDialog.cs`、`mcdl/native/`、`mcdl/McdlDialog.exe` |
| 文档 | `mcdl/README.md` 结构树与「信任区」文案、`.gitignore` 的 `/mcdl/McdlDialog.exe` 均已清理 |

**验证**：`build.ps1` 退出码 0（21 源文件）；`mcdl.jar` 204.1 KB / 73 条目（去掉 C# 载荷后变小）；`--version` → `MCDL 1.0.8`；`mcdl/src` 内 `McdlDialog` 引用 **0**；`Test-Path mcdl/McdlDialog.exe` → False；`native/` 不存在；Electron 全量测试 **284/284 pass**。

**已知取舍**：选择框从资源管理器风格的 `IFileOpenDialog` 退成 Swing `JFileChooser`（观感较旧，且与 Electron 侧原生对话框不一致）；「打开文件夹」失去 `ShellExecuteEx` 的真实 HRESULT，只能靠「explorer 立即异常退出」判负，HIPS 拦截时仍走应用内 `FolderWindow` 兜底（与旧行为一致）。这是为了消除未签名 exe 付出的代价，仅影响备用 Swing GUI。
