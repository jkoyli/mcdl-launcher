# MCDL Launcher

Windows 上的 Minecraft: Java Edition 启动器。界面为 Electron 自绘的无边框窗口（空心囗 / Hollow Frame），
内置原版下载器 `mcdl`，实例安装、账户与游戏启动均在本仓库内实现，不依赖 JavaFX 或第三方启动器。

| 项目 | 说明 |
| --- | --- |
| 平台 | Windows 10 / 11 |
| 界面 | Electron 无边框窗口，自绘标题栏 |
| 下载 | 内置 `mcdl.jar`（MIT） |
| 进度 | 可安装原版并真实启动；模组加载器安装尚未接入 |

## 功能

- **实例管理** — 通过 `mcdl` 下载安装原版，安装进度实时回显；支持实例别名与版本类型筛选。
- **启动游戏** — 解析版本 JSON（含 `inheritsFrom` 合并），拼接 classpath、natives 与启动参数，
  自动匹配 Java，回传进程 PID、退出码与失败原因。
- **账户** — 离线账号与微软账号（应用内登录窗口，令牌仅存本机）。
- **游戏设置** — 最大内存、指定 Java、窗口尺寸、额外 JVM 参数。

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

- 新建实例仅支持原版；Fabric / Forge / NeoForge / Quilt 选项保持禁用。
- 「下载中心」尚无对应面板，新闻区为占位内容。
- 「修改 / 添加游戏文件夹 / 全局游戏设置」为禁用占位。

## 许可证

- `mcdl/` 采用 MIT，见 [mcdl/LICENSE](mcdl/LICENSE)。
- `docs/history/` 下的界面清单与根目录 `LICENSE` 来自本项目早期的 HMCL 定制分支，沿用 GPLv3。
- `electron/` 及其他文件为本仓库重新实现。

## 背景

本项目早期是 HMCL 的 JavaFX 定制分支，界面与启动逻辑后经重写为 Electron 实现，
仓库历史重整为单一初始提交；原 JavaFX 工程已移出仓库，不参与构建与运行。
