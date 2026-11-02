# MCDL Launcher

Windows 上的 Minecraft: Java Edition 启动器。界面为 Electron 自绘的无边框窗口（空心囗 / Hollow Frame），
内置原版下载器 `mcdl`，实例安装、账户与游戏启动均在本仓库内实现，不依赖 JavaFX 或第三方启动器。

| 项目 | 说明 |
| --- | --- |
| 平台 | Windows 10 / 11 |
| 界面 | Electron 无边框窗口，自绘标题栏 |
| 下载 | 内置 `mcdl.jar`（MIT） |
| 进度 | 可安装原版与 Forge / NeoForge / Fabric / Quilt，并能真实启动 |

## 功能

- **实例管理** — 通过 `mcdl` 下载安装原版或加载器（Forge / NeoForge / Fabric / Quilt），安装进度实时回显；支持实例别名与版本类型筛选。
- **世界管理** — 实例详情「世界」页签：世界列表（图标 / 版本 / 模式 / 难度 / 大小），世界信息直接读写
  `level.dat`（作弊 / 生成建筑 / 难度 / 难度锁定 / 游戏模式），支持导出、复制、删除、世界文件夹与
  Chunkbase 地图；备份管理（zip 备份 / 恢复 / 删除）与数据包导入 / 删除。
- **下载中心** — 侧边栏独立页面：游戏版本卡片（最新正式版 / 最新快照 / 类型筛选 / 搜索 / 刷新）＋安装向导（加载器、加载器版本、实例名、是否下载 assets）；
  整合包支持本地 `.zip` / `.mrpack`（预览包内文件后交给 `mcdl --install-pack`）；模组 / 资源包 / 光影直连 Modrinth，
  按当前实例的版本与加载器筛选，可选同时安装必需前置，或只下载到本地文件夹。
- **启动游戏** — 解析版本 JSON（含 `inheritsFrom` 合并），拼接 classpath、natives 与启动参数，
  自动匹配 Java，回传进程 PID、退出码与失败原因。
- **账户** — 离线账号、微软账号（应用内登录窗口）与第三方 authlib-injector 服务器登录；
  账号页包含微软登录、添加账户（离线 / 正版登录页签）、认证服务器向导、离线皮肤与删除确认五个弹窗。
  令牌仅存本机，不进入渲染进程。
- **设置** — 六个页签：游戏设置（内存 / 窗口 / JVM 参数 / 默认版本隔离策略）、Java 管理（扫描与指定运行时）、
  通用（语言 / 日志目录）、外观（关闭动画）、下载（版本列表源 / 下载源 / 附加内容源）、关于（版本与开源许可）。

## 环境要求

- Windows 10 / 11
- Node.js 20+
- JDK 17+ — 运行 `mcdl.jar` 所需
- 游戏运行所需的 Java 由启动器自动探测；安装 1.16 及更早版本时请自备 Java 8

## 安装与运行

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
├── mcdl/                # 内置 MCDL 下载器（Java 源码 + mcdl.jar）
├── docs/                # 开发文档、排障记录
│   └── history/         # 重写前的 HMCL 界面控件清单（仅参考）
├── run-electron.ps1     # 启动脚本
├── 启动.bat             # 双击启动
├── README.md
└── LICENSE
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/development.md](docs/development.md) | 模块划分、启动与账户实现、IPC 通道、数据文件 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 启动失败、无窗口、执行策略等常见问题 |
| [mcdl/README.md](mcdl/README.md) | 上游 `mcdl` 下载器说明 |

## 已知限制

- 自动安装支持原版与 Forge / NeoForge / Fabric / Quilt；OptiFine 需要官网安装器，LiteLoader 已停止更新，
  两者的入口保持禁用。
- 「下载中心」的「世界」页签还没有在线源（Modrinth 无世界分类，CurseForge 需要 API Key）。
- 新闻区仍是占位内容。
- 离线皮肤只做保存与预览，游戏内生效还需要自定义皮肤服务。

## 许可证

- `mcdl/` 采用 MIT，见 [mcdl/LICENSE](mcdl/LICENSE)。
- `docs/history/` 下的界面清单与根目录 `LICENSE` 来自本项目早期的 HMCL 定制分支，沿用 GPLv3。
- `electron/` 及其他文件为本仓库重新实现。

## 背景

本项目早期是 HMCL 的 JavaFX 定制分支，界面与启动逻辑后经重写为 Electron 实现，
仓库历史重整为单一初始提交；原 JavaFX 工程已移出仓库，不参与构建与运行。
