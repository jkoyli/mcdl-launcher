# MCDL Launcher

Windows 上的 Minecraft: Java Edition 启动器：Electron 自绘的无边框界面（空心囗 / Hollow Frame）加内置的
原版下载器 `mcdl`。界面、实例管理、账户与启动逻辑都在本仓库内实现，不依赖 JavaFX 或任何外部启动器。

| | |
| --- | --- |
| 平台 | Windows 10 / 11 |
| 界面 | Electron（无边框自绘标题栏） |
| 下载 | 内置 `mcdl.jar`（MIT） |
| 状态 | 可安装原版并真实启动；加载器安装尚未接入 |

## 功能

- **实例管理**：通过 `mcdl` 下载并安装原版，安装进度实时回显；实例列表、别名、版本类型筛选。
- **真实启动**：解析版本 JSON（含 `inheritsFrom` 合并），拼接 `classpath`、natives、
  `arguments.jvm` / `arguments.game`，自动挑选匹配的 Java，拉起 `javaw.exe` 并回传 PID、退出码与失败原因。
- **账户**：离线账号（官方离线 UUID 算法）与微软账号（应用内登录窗口，令牌只保存在本机）。
- **游戏设置**：最大内存、指定 Java、窗口尺寸、额外 JVM 参数。
- **界面**：空心囗主视区、毛玻璃面板、3D 方块舞台，无边框窗口自绘标题栏与窗口控制。

## 环境要求

- Windows 10 / 11
- Node.js 20+
- JDK 17+（用于运行 `mcdl.jar`）
- 游戏本身需要的 Java 由启动器自动探测（安装了旧版本时请自备 Java 8）

## 快速开始

```powershell
git clone https://github.com/jkoyli/mcdl-launcher.git
cd mcdl-launcher
```

（也支持 SSH：`git clone git@github.com:jkoyli/mcdl-launcher.git`。）

首次运行时如果 `electron/node_modules` 不存在，`run-electron.ps1` 会自动执行 `npm install`。

双击 `启动.bat` 启动；或从 PowerShell 启动：

```powershell
.\run-electron.ps1
```

开发模式（自动打开 DevTools）：

```powershell
.\run-electron.ps1 -Dev
```

默认使用软件渲染，以规避部分 Windows 机器上 Electron GPU 子进程崩溃的问题。需要硬件加速时：

```powershell
.\run-electron.ps1 -EnableGpu
```

PowerShell 执行策略拦截 `electron.ps1` 时的替代启动方式，见 [electron/README.md](electron/README.md)。

## 数据目录

默认只使用 MCDL Launcher 自己的游戏目录：

```text
%APPDATA%\MCDL Launcher\.minecraft
```

首次启动会自动创建标准结构：

```text
versions/  libraries/  assets/  assets/indexes/  assets/objects/
logs/  saves/  mods/  resourcepacks/  shaderpacks/
mcdl-launcher.json
```

新安装的实例写入这个目录；启动时也只读取这里，不会自动扫描 PCL / HMCL。

应用自身的数据（不写入游戏目录）：

| 文件 | 内容 |
| --- | --- |
| `%APPDATA%\mcdl-launcher-electron\accounts.json` | 账号与令牌 |
| `%APPDATA%\mcdl-launcher-electron\launcher-settings.json` | 内存 / Java / 窗口尺寸 / 额外 JVM 参数 |
| `%APPDATA%\mcdl-launcher-electron\instance-display-names.json` | 实例别名 |
| `%APPDATA%\mcdl-launcher-electron\scanned-game-dirs.json` | 主动扫描过的其他启动器目录 |
| `<游戏目录>\logs\mcdl-launcher-<时间戳>.log` | 每次启动的 Java 命令行与游戏输出 |

## 扫描其他启动器

实例管理页底部有「扫描实例」按钮，下方说明「扫描其他启动器实例位置，结果会缓存」。

只有点击这个按钮才会查找 PCL / HMCL 的位置，结果写入 `scanned-game-dirs.json`；之后启动会读取缓存，
直接识别已扫描过的实例。删除该缓存文件即可恢复「只读自己的目录」。

外部实例只被读取，不会被复制或移动。

## 版本类型

实例管理页的「游戏版本」行右侧有类型下拉：

```text
正式版 / 快照 / 远古版 / 全部
```

默认选中「正式版」。切换类型会立即刷新版本列表，并同步更新默认实例名称。

## 目录结构

```text
mcdl-launcher/
├── electron/            # Electron UI：主进程、preload、渲染进程、启动与账户模块
├── mcdl/                # 内置 MCDL 下载器（Java 源码 + mcdl.jar）
├── docs/                # 历史 UI 控件清单，仅作设计参考
├── run-electron.ps1     # 启动 Electron
├── 启动.bat             # 双击启动
├── README.md
└── LICENSE
```

详细的实现说明、IPC 通道表与已知问题排查，见 [electron/README.md](electron/README.md)。

## 构建内置 mcdl

`mcdl.jar` 已随仓库提供，一般无需重新构建。需要时：

```powershell
cd mcdl
.\build.ps1
```

产物为 `mcdl\mcdl.jar`。

## 已知限制

- 新建实例只支持原版；Fabric / Forge / NeoForge / Quilt 选项保持禁用。
- 「下载中心」侧边栏项还没有面板；新闻区仍是占位。
- 「修改 / 添加游戏文件夹 / 全局游戏设置」为禁用占位，避免假点击。

## 许可证

- `mcdl/` 采用 MIT，见 [mcdl/LICENSE](mcdl/LICENSE)。
- `docs/` 与根目录 `LICENSE` 来自本项目早期的 HMCL 定制分支，沿用 GPLv3；
  `electron/` 与仓库中的其余文件为重新实现的部分。

## 背景

本项目早期是一个 HMCL / JavaFX 的定制分支。界面与启动逻辑后来重写为 Electron 实现，
仓库历史也随之重整为单一初始提交；此前的 JavaFX 工程与构建脚本已从仓库移除，不再参与构建或运行。
