# MCDL Launcher

MCDL Launcher 现在只包含两套东西：

- `electron/`：空心囗 Electron UI
- `mcdl/`：内置的原版下载器源码 + `mcdl.jar`

**运行时不包含、也不依赖 HMCL 源码或 JavaFX 启动器。**

原先的 HMCL/JavaFX 定制工程已移到同级目录 `..\hmcl-reference`，保留源码、构建脚本和 `dist`，方便后续参考；它和本 Electron 工程是分开的。

## 目录

```text
mcdl-launcher/
├── electron/            # Electron UI
├── mcdl/                # 内置 MCDL 下载器（源码 + mcdl.jar）
├── docs/                # 历史 UI 控件清单，仅作设计参考
├── run-electron.ps1     # 启动 Electron
├── 启动.bat             # 双击启动 Electron
├── README.md
└── LICENSE
```

## 环境

- Node.js 20+
- JDK 17+（运行 `mcdl.jar`）
- Windows 10/11

Electron 依赖已经在 `electron/node_modules` 中；如果缺失，`run-electron.ps1` 会自动执行 `npm install`。

## 启动

双击：

```text
启动.bat
```

它会直接启动 Electron UI，不再启动 JavaFX。

也可以从 PowerShell 启动：

```powershell
cd C:\Users\luoxi\Desktop\java\mcdl-launcher
.\run-electron.ps1
```

HMCL/JavaFX 参考工程在 `..\hmcl-reference`，需要看实现时再进入那个目录，不影响这里启动。

或直接双击：

```text
启动.bat
```

开发模式：

```powershell
.\run-electron.ps1 -Dev
```

默认用软件渲染，规避部分 Windows 机器上 Electron GPU 子进程崩溃的问题。需要硬件加速时：

```powershell
.\run-electron.ps1 -EnableGpu
```

## 实例目录

默认只使用 MCDL Launcher 自己的目录：

```text
%APPDATA%\MCDL Launcher\.minecraft
```

首次启动会自动创建标准结构：

```text
versions/ libraries/ assets/ assets/indexes/ assets/objects/
logs/ saves/ mods/ resourcepacks/ shaderpacks/
mcdl-launcher.json
```

下载的新实例会写入这个目录。

启动时只读取这个目录，不自动扫描 PCL/HMCL。

## 扫描其他启动器

实例管理页底部有：

```text
扫描实例
```

下方小字：

```text
扫描其他启动器实例位置，结果会缓存
```

只有点击这个按钮才会查找 PCL/HMCL 的位置。扫描结果写入：

```text
%APPDATA%\mcdl-launcher-electron\scanned-game-dirs.json
```

之后再启动会读取缓存，直接识别已扫描过的其他启动器实例。删除该缓存文件即可恢复“只读自己的目录”。

外部实例只被读取，不会被复制或移动。

## 版本类型

实例管理页的「游戏版本」行右侧有类型下拉：

```text
正式版 / 快照 / 远古版 / 全部
```

默认选中「正式版」。切换类型会立即刷新下方的版本列表，并同步更新默认实例名称。

## 构建内置 mcdl

`mcdl.jar` 已经内置。需要重新构建时：

```powershell
cd mcdl
.\build.ps1
```

产物：

```text
mcdl\mcdl.jar
```

## 启动游戏

启动按钮已经接入真实流程（`electron/launch.js`）：

- 按版本 JSON（含 `inheritsFrom` 合并）拼 `classpath`、natives、`arguments.jvm` / `arguments.game`
- 自动挑 Java（64 位优先、按版本 `javaVersion.majorVersion` 匹配），也可在设置里固定
- 支持离线账号与微软账号（应用内登录窗口，令牌只存本机）
- 启动日志写入 `<gameDir>/logs/mcdl-launcher-<时间戳>.log`，按钮上方显示 PID / 退出码 / 失败原因

设置保存在 `%APPDATA%\mcdl-launcher-electron\launcher-settings.json`（内存 / Java / 窗口尺寸 / 额外 JVM 参数），
账号保存在同目录的 `accounts.json`。

## 当前限制

- 新建实例目前只支持原版；Fabric / Forge / NeoForge / Quilt 选项禁用。
- 「下载中心」侧边栏项还没有面板；新闻区仍是占位。
- 「修改 / 添加游戏文件夹 / 全局游戏设置」仍是禁用占位，避免假点击。

## 许可证

- `mcdl/` 使用 MIT，见 [mcdl/LICENSE](mcdl/LICENSE)。
- 根目录 `LICENSE` 是历史 HMCL 分支保留的 GPL 文件，仅用于 `docs/` 等历史资料。
