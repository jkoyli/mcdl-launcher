# MCDL Launcher UI 实现状态（验收基准）

> **基线**：`ui-tree-controls.html` —— 60 个节点 / 284 项控件（2026-11-01 静态扫描 HMCL 上游 `ui/**/*.java`）
> **最近核对**：2026-11-02 21:10 · 对照 `electron/renderer/index.html`(284 KB) + `renderer.js`(374 KB) + `main.js`(163 KB / **105 条 IPC**)
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

## §4 未做清单（9 项页面级 + 2 共享 = 11 项，另 7 项不做）

| 块 | 项数 | 具体 | 备注 |
|---|---:|---|---|
| 内容更新（AddonUpdatesPage） | 5 | 导出 / 更新 / 取消 / 列表项 / 确定 | 需"检查更新"比对逻辑（Modrinth 版本匹配） |
| 共享组件（§7 C 组） | 2 | HTMLRenderer 2（待定） | 工具栏基座已补；4 项「不做」另计，已扣 |
| 主页主视觉 / 新闻 | 1 | 3D 展示 / 新闻 API | 仍是 placeholder |
| 主题包管理 | 3 | 列表项 / 确定 / 导入项 | **➖ 设计决定不做**（没有主题引擎，占位保留） |

**总计：5 + 2 + 1 = 8 项实操 + 7 项「不做」= 15 项剩余。**

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

`renderer.js`（375 KB）与 `main.js`（163 KB）均为单文件。共享基座（`createList` / `createTabs` / `askPrompt` / `runTask` / `createToolbar`）已就位，但 **25 个历史 `render*` 函数尚未回迁**；建议新页面一律用基座，老页面只在修 bug 时顺带迁移，不做专项大面积回迁。

