# MCDL Launcher

> **v0.3.3 · 内测包**（本地音乐播放器 / Java 国内镜像 / 重影与卡片动效修复）
> 当前以 **zip 免安装包**分发；更新方式是**文件覆盖**（解压新版本 → 覆盖到启动器目录），见[更新](#更新)。

Windows 上的 Minecraft: Java Edition 启动器。界面为 Electron 自绘的无边框窗口（Hollow Frame），
内置原版下载器 `mcdl`，实例安装、账户与游戏启动均在本仓库内实现，不依赖 JavaFX 或第三方启动器。

| 项目 | 说明 |
| --- | --- |
| 平台 | Windows 10 / 11（x64） |
| 界面 | Electron 无边框窗口，自绘标题栏 |
| 下载 | 内置 `mcdl.jar`（MIT） |
| 进度 | 可安装原版与 Forge / NeoForge / Fabric / Quilt，并能真实启动 |
| 分发 | zip 免安装 / NSIS 安装包 / portable 单文件 |

## 功能

- **实例管理** — 通过 `mcdl` 下载安装原版或加载器（Forge / NeoForge / Fabric / Quilt），安装进度实时回显；支持实例别名与版本类型筛选。
- **实例详情** — 7 个页签（游戏设置 / 自动安装 / 模组 / 资源包 / 世界 / 截图 / 原理图）＋
  更新整合包、测试游戏、浏览、管理 4 个导航项；管理菜单可更新 / 删除游戏资源与库文件、清理日志，
  截图页签支持设为启动器背景、复制到剪贴板。
- **世界管理** — 实例详情「世界」页签：世界列表（图标 / 版本 / 模式 / 难度 / 大小），世界信息直接读写
  `level.dat`（作弊 / 生成建筑 / 难度 / 难度锁定 / 游戏模式），支持导出、复制、删除、世界文件夹与
  Chunkbase 地图；备份管理（zip 备份 / 恢复 / 删除）与数据包导入 / 删除。
- **下载中心** — 侧边栏独立页面：游戏版本卡片（最新正式版 / 最新快照 / 类型筛选 / 搜索 / 刷新）＋安装向导（加载器、加载器版本、实例名、是否下载 assets）；
  整合包支持本地 `.zip` / `.mrpack`（预览包内文件后交给 `mcdl --install-pack`）；模组 / 资源包 / 光影直连 Modrinth，
  按当前实例的版本与加载器筛选，可选同时安装必需前置，或只下载到本地文件夹。
- **导出整合包** — 3 步向导：CurseForge / Modrinth 格式 → 选择模组 / 配置 / 资源包 / 光影 / 存档 / 投影 / 游戏选项
  → 填名称 / 版本 / 作者 / 认证服务器与 4 个开关，打包成可被其他启动器导入的 zip。
- **启动游戏** — 解析版本 JSON（含 `inheritsFrom` 合并），拼接 classpath、natives 与启动参数，
  自动匹配 Java，回传进程 PID、退出码与失败原因；日志窗口支持自动滚动 / 导出 / 结束进程 / 导出运行栈，
  异常退出时弹出游戏崩溃窗口（导出崩溃信息 / 查看日志 / 帮助）。启动前先校验必需文件
  （缺文件不拉起 Java，可按清单一键修复）；界面崩溃分三层恢复，兜底是零依赖恢复页。
  失败模式的完整清单见[失败路径审计](docs/failure-path-audit.md)。
- **账户** — 离线账号、微软账号（应用内登录窗口）与第三方 authlib-injector 服务器登录；
  账号页包含微软登录、添加账户（离线 / 正版登录页签）、认证服务器向导、离线皮肤与删除确认五个弹窗。
  令牌仅存本机，不进入渲染进程。
- **设置** — 六个页签：游戏设置（预设 / 内存 / 窗口 / JVM 参数 / 默认版本隔离策略）、Java 管理（扫描、指定运行时、
  从 Adoptium 一键安装 JDK（默认国内镜像优先、失败回退官方）、选错或失效时一键「恢复默认」）、通用（语言 / 日志目录 / NBT 编辑器）、
  外观（主题模式 跟随系统·浅色·深色 / 色彩模式与自定义主色 / 导出主题快照 / 自上传壁纸）、
  下载（版本列表源 / 下载源 / 附加内容源 / Java 下载源）、关于（版本与开源许可）。
- **本地音乐** — 右上角圆钮：悬停展开面板（可图钉固定），支持 mp3 / flac / wav / m4a / aac / ogg / opus；
  播放列表由主进程维护（`<userData>/music-playlist.json`，上限 500 首），可拖动进度、调音量、
  随机 / 列表循环 / 单曲循环；收起面板后继续播放，圆钮上显示电平条与进度环，文件丢失的曲目会标灰并可移除。
- **数据安全** — 所有状态文件（账号、实例设置、别名、扫描缓存、启动脚本、音乐播放列表、设置）都走
  **原子写**：同目录临时文件 → `fsync` → `rename` 覆盖，断电或强杀不会留下 0 字节 / 半截 JSON；
  关闭窗口时若还有安装 / 下载任务在跑、或刚保存的写入还没落盘，先取消任务并等它们收尾（≤5 秒）、
  再等排队写入落盘（≤3 秒）才退出；两者都没有时和以前一样，立即关。
  规则见[开发文档](docs/development.md#持久化所有状态写入必须原子)，失败模式清单见
  [失败路径审计](docs/failure-path-audit.md)。

## 环境要求

- Windows 10 / 11
- Node.js 20+
- JDK 17+ — 运行 `mcdl.jar` 所需
- 游戏运行所需的 Java 由启动器自动探测；安装 1.16 及更早版本时请自备 Java 8

## 安装与运行

### 方式一：用内测包（推荐给测试者）

1. 下载 `MCDL-Launcher-0.3.3-x64.zip`
2. 解压到任意目录（不要放进 `C:\Program Files`，避免写入受限）
3. 双击目录里的 `MCDL Launcher.exe`

程序不会写系统目录：配置、账户、日志都在 `%APPDATA%\mcdl-launcher-electron\`，
游戏文件默认在 `%APPDATA%\MCDL Launcher\.minecraft`。

> 首次运行会触发 SmartScreen「未知发布者」提示（内测包尚未签名），点「更多信息 → 仍要运行」即可。

### 方式二：从源码运行

```powershell
git clone https://github.com/jkoyli/mcdl-launcher.git
cd mcdl-launcher
```

双击 `启动.bat`，或从 PowerShell 启动：

```powershell
.\run-electron.ps1
```

首次运行时若 `electron/node_modules` 缺失，`run-electron.ps1` 会先执行 `npm install`。

开发模式（自动打开 DevTools）：

```powershell
.\run-electron.ps1 -Dev
```

## 更新

当前阶段**没有自动更新**（更新通道的骨架已在代码里，默认关闭；没有配置更新源）。

### 已安装用户：用小版本更新包（推荐）

只覆盖这次改动到的程序文件，不动你的账号 / 设置 / 游戏：

1. 下载 `MCDL-Launcher-0.3.3-update.zip` 并解压
2. 进入解压出来的 `MCDL-Launcher-0.3.3-update` 文件夹，**全选**里面的所有文件和文件夹
3. 复制到原来的启动器目录（和 `MCDL Launcher.exe` 同一层），选择「替换目标中的文件」
4. 重新打开 `MCDL Launcher.exe`

更新包里只有 `MCDL Launcher.exe`、`resources/app.asar`、`resources/mcdl/mcdl.jar`，
没有 `resources/jre`（内置 JRE 没变）和用户数据，复制很快。

### 第一次安装 / 目录损坏：用完整 zip

1. 下载 `MCDL-Launcher-0.3.3-x64.zip`
2. 解压到一个空目录（或直接覆盖原目录）
3. 把里面的所有文件**复制进原来的启动器目录**，覆盖同名文件
4. 重新打开 `MCDL Launcher.exe`

需要注意：

- **只覆盖程序文件，不要动 `%APPDATA%\mcdl-launcher-electron\`**（那是你的账户与设置），
  也不要动 `%APPDATA%\MCDL Launcher\`（那是游戏与实例）。
- 旧版本残留的多余文件不会自动删除；如果遇到异常，建议删掉旧目录后全新解压一次。
- 覆盖前建议先关掉启动器，避免 `MCDL Launcher.exe` 被占用导致复制不完整。

## 从源码打包

```powershell
cd electron
npm install
npm run dist          # NSIS 安装包 + portable + zip → ..\dist\
npm run dist:dir      # 只出目录（最快，用于验证包结构）
```

可选：把精简版 JRE 一起打进去（没装 Java 的机器也能开箱即用）

```powershell
npm run fetch:jre              # 下载 Temurin JRE 21 到 electron\jre\（默认国内镜像优先）
npm run fetch:jre -- --official  # 只走 Adoptium / GitHub
npm run fetch:jre -- --mirror    # 只走清华 TUNA 镜像
```

发版、签名、更新源、冒烟清单见 [docs/packaging.md](docs/packaging.md)。

默认使用硬件加速。如果 GPU 子进程崩溃，启动器会记录这次崩溃，并在下次启动时自动改用软件渲染
（软件模式下会关闭毛玻璃等每帧重算的效果以保证流畅）。需要强制软件渲染时加 `-SoftwareRender`。

## 数据位置

游戏文件默认只写入启动器自己的目录：

```text
%APPDATA%\MCDL Launcher\.minecraft
```

首次启动会创建标准结构（`versions/`、`libraries/`、`assets/`、`logs/`、`saves/`、`mods/` 等）并写入
`mcdl-launcher.json` 标记。启动时只读取该目录，不会自动扫描其他启动器。

启动器自身的配置保存在 `%APPDATA%\mcdl-launcher-electron\`：账户（`accounts.json`）、
设置（`launcher-settings.json`）、实例别名与扫描缓存。该目录不可写时会自动回退到
`%LOCALAPPDATA%` 或程序目录下的 `data/`，实际路径见启动日志的 `[data] userData:` 一行；
也可以用 `MCDL_USER_DATA` 指定。完整清单见 [开发文档](docs/development.md#数据文件)。

## 扫描其他启动器

实例管理页底部的「扫描实例」按钮用于查找 PCL / HMCL 的实例位置，结果写入扫描缓存，之后启动会直接识别。
外部实例只读，不会被复制或移动。删除缓存文件即可恢复只读取自身目录的行为。

## 从源码构建内置 mcdl

`mcdl.jar` 已随仓库提供，通常无需重建。需要时：

```powershell
cd mcdl
.\build.ps1
```

产物为 `mcdl\mcdl.jar`。

## 目录结构

```text
mcdl-launcher/
├── electron/            # Electron 主进程、preload、渲染进程、启动与账户模块
│   ├── renderer/        # index.html / renderer.js / assets（界面图片资源）
│   ├── build/           # 打包图标（icon.ico / icon.png）
│   ├── scripts/         # fetch-jre.js（下载内置 JRE）
│   ├── tests/           # node:test 用例（343 条）
│   └── electron-builder.yml
├── mcdl/                # 内置 MCDL 下载器（Java 源码 + mcdl.jar）
├── docs/                # 开发文档、排障记录、打包手册
│   └── history/         # 重写前的 HMCL 界面控件清单（仅参考）
├── run-electron.ps1     # 启动脚本
├── 启动.bat             # 双击启动
├── README.md
└── LICENSE
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/packaging.md](docs/packaging.md) | 打包、发版、更新源、代码签名、冒烟清单 |
| [docs/development.md](docs/development.md) | 模块划分、启动与账户实现、IPC 通道、数据文件 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 启动失败、无窗口、执行策略等常见问题 |
| [docs/failure-path-audit.md](docs/failure-path-audit.md) | 失败路径审计：PCL2 / HMCL 历史 bug 的复现判定、修复点与测试清单 |
| [mcdl/README.md](mcdl/README.md) | 上游 `mcdl` 下载器说明 |

## 已知限制

- 自动安装支持原版与 Forge / NeoForge / Fabric / Quilt；OptiFine 需要官网安装器，LiteLoader 已停止更新，
  两者的入口保持禁用。
- 「下载中心」的「世界」页签还没有在线源（Modrinth 无世界分类，CurseForge 需要 API Key）。
- 新闻区仍是占位内容。
- 离线皮肤只做保存与预览，游戏内生效还需要自定义皮肤服务。
- **主题**：只有浅色 / 深色与自定义主色，没有主题包（自定义 CSS）机制；浅色是**反相方案**
  （`filter: invert(1) hue-rotate(180deg)`，原生控件用 `color-scheme: light` 对齐），个别图片仍可能有
  轻微色偏。抗锯齿、标题栏透明、窗口透明同理保留禁用。设置存在 `localStorage`（键 `mcdl.theme.v1`），
  不随设置文件备份 / 迁移。已知副作用与排查见[排障](docs/troubleshooting.md)。
- 启动脚本三件套（`.ps1` / `.bat` / `data.json`）是三次独立原子写，**不是跨文件事务**。

## 许可证

- `mcdl/` 采用 MIT，见 [mcdl/LICENSE](mcdl/LICENSE)。
- `docs/history/` 下的界面清单与根目录 `LICENSE` 来自本项目早期的 HMCL 定制分支，沿用 GPLv3。
- `electron/` 及其他文件为本仓库重新实现。

## 背景

本项目早期是 HMCL 的 JavaFX 定制分支，界面与启动逻辑后经重写为 Electron 实现，
仓库历史重整为单一初始提交；原 JavaFX 工程已移出仓库，不参与构建与运行。
