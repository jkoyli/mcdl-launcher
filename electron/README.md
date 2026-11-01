# Hollow Launcher · Electron

“空心囗”启动器的 Electron UI，属于 `mcdl-launcher` 工程的一部分。窗口为无边框自绘标题栏，渲染进程通过 preload 暴露的 `window.launcherAPI` 与主进程通信。

## 在 mcdl-launcher 中的位置

```text
mcdl-launcher/
├── electron/                # 本 UI
│   ├── main.js              # 主进程：窗口、IPC、安装与启动协调
│   ├── preload.js           # contextBridge 白名单
│   ├── mcdl-service.js      # 调用 mcdl/mcdl.jar（实例扫描、版本列表、安装）
│   ├── java-runtime.js      # 本机 Java 探测与版本挑选
│   ├── version-manifest.js  # 版本 JSON 解析：inheritsFrom / rules / classpath / natives
│   ├── launch.js            # 真实启动：拼命令、解压 natives、拉起进程
│   ├── accounts.js          # 离线账号与微软登录
│   └── renderer/            # 渲染进程：index.html + renderer.js
├── mcdl/                    # 内置的原版下载器源码 + mcdl.jar
├── docs/                    # 历史 UI 控件清单（仅参考，运行时不需要）
├── run-electron.ps1
└── 启动.bat                 # 启动本 Electron UI
```

运行时不包含、也不依赖 HMCL 源码或 JavaFX。

`mcdl` 内置在仓库的 `mcdl/` 目录中，不依赖外部安装。`mcdl-service.js` 默认读取：

```text
mcdl-launcher/mcdl/mcdl.jar
```

## 运行

从 `mcdl-launcher` 根目录：

```powershell
.\run-electron.ps1
```

或双击 mcdl-launcher 根目录的 `启动.bat`。

也可以直接进入本目录：

```bash
npm install
npm run dev
```

开发模式（自动打开 DevTools、带 `--no-sandbox`）：

```bash
npm run dev
```

> 当前 Windows 环境需要开发模式的 `--no-sandbox` 才能启动渲染进程；它只用于本地调试。正式发布时应在正常的桌面环境中移除该参数，恢复 Chromium 沙箱。
>
> `run-electron.ps1` / `dev.cmd` 默认设置 `MCDL_DISABLE_GPU=1`，规避部分 Windows 机器上 Electron GPU 子进程直接崩溃的问题。需要硬件加速时使用：
>
> ```powershell
> .\run-electron.ps1 -EnableGpu
> ```
>
> 软件渲染会让 `backdrop-filter`、3D 方块和流光动画变慢；正常 GPU 可用时再开启。
>
> 如果不打开 DevTools，但仍需在当前机器上本地运行，使用：
>
> ```powershell
> npm.cmd run start:local
> ```

### Windows PowerShell 执行策略问题

如果在 PowerShell 中看到：

```text
无法加载文件 ...\node_modules\.bin\electron.ps1。
未对文件 ...\electron.ps1 进行数字签名。无法在当前系统上运行该脚本。
```

这不是项目或 Electron 安装失败，而是 PowerShell 执行策略拦截了 `.ps1` shim。

任选一种方式启动：

```powershell
# 方式 1：只对当前终端会话放开执行策略
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
npm run dev
```

```powershell
# 方式 2：绕过 PowerShell shim，直接使用 npm.cmd
npm.cmd run dev
```

```powershell
# 方式 3：直接调用已下载的 Electron 二进制
.\node_modules\electron\dist\electron.exe .
```

最方便的是双击或运行项目根目录的 `dev.cmd`：

```powershell
.\dev.cmd
```

`dev.cmd` 内部使用 `npm.cmd`，不会再触发 PowerShell 的 `.ps1` 签名策略。

### 启动后没有窗口，直接回到提示符

通常是此前某次启动留下了隐藏的 Electron 进程，新进程被单实例锁直接结束。当前开发模式已经绕过单实例锁，并增加了启动日志。

仍然没有窗口时，先清理本项目的残留进程：

```powershell
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*mcdl-launcher*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

然后重新执行：

```powershell
.\dev.cmd
```

正常情况下终端应出现：

```text
[main] booting Electron app (dev=true)
[main] single instance lock: true
[main] app ready
[main] BrowserWindow created
[main] window ready to show
[mcdl] jar: ...\mcdl\mcdl.jar
[mcdl] default game dir: ...\.minecraft
```

如果进程仍然马上退出，直接运行带日志的 Electron 二进制收集错误：

```powershell
$env:ELECTRON_ENABLE_LOGGING = "1"
.\node_modules\electron\dist\electron.exe --no-stdio-init --no-sandbox . --dev --enable-logging
```

### 关于 `--no-stdio-init`

当前 Electron 45 在 Windows 上可能因为 NUL 设备不可用，在 Node stdio 初始化阶段直接崩溃。启动脚本已经加入官方 workaround：

```text
electron --no-stdio-init .
```

注意：该 workaround 只适用于 Electron 45 及更早版本；Electron 46 已内置 NUL 自动检测并移除了这个开关。

如果进程仍然马上退出，并且连最小 Electron 空应用都会以 `0xC0000005` 崩溃，说明当前会话限制了 Electron/Chromium 的 GUI 子进程，此时需要换到普通交互式桌面会话或另一台 Windows 机器测试。

## 真实游戏目录与 mcdl

实例数据不再来自 `test-data`，而是由 `mcdl-service.js` 调用同级的 `mcdl/mcdl.jar`：

1. 默认只使用 MCDL Launcher 自己的游戏目录，并自动创建标准 `.minecraft` 结构。
2. 只扫描自己的 `<gameDir>/versions/*`，不自动读取 PCL / HMCL。
3. 用户点击「扫描实例」时，才调用 `mcdl --list-dirs` 查找其他启动器位置。
4. 找到的其他目录写入扫描缓存；之后启动会读取缓存并自动识别。
5. 扫描每个实例的 `<id>.json`，从 `libraries` / `mainClass` 识别加载器。
6. 如果存在 `.hmcl/config/instance-game-settings.json`，读取真实 JVM 参数和 Java 版本。
7. 版本下拉框通过 `mcdl --list --type all` 获取正式版 / 快照 / 远古版，并按类型筛选，缓存 10 分钟。

默认路径：

```text
mcdl.jar       <mcdl-launcher>/mcdl/mcdl.jar
gameDir        %APPDATA%/MCDL Launcher/.minecraft
scan cache     %APPDATA%/mcdl-launcher-electron/scanned-game-dirs.json
```

游戏目录会自动创建：

```text
versions/  libraries/  assets/  assets/indexes/  assets/objects/
logs/  saves/  mods/  resourcepacks/  shaderpacks/
mcdl-launcher.json   # 目录归属标记
```

可覆盖：

```powershell
$env:MCDL_JAR = "D:\MCDL\mcdl.jar"
$env:MCDL_JAVA = "C:\Program Files\Microsoft\jdk-17.0.11.9-hotspot\bin\java.exe"
$env:MCDL_GAME_DIR = "D:\MC\.minecraft"
npm.cmd run dev
```

新建实例时，主进程会执行：

```text
java -Dfile.encoding=UTF-8 -jar mcdl.jar --install <version> --dir <自己的 gameDir> --source auto --jobs 16
```

安装过程中的 mcdl 输出会通过 `instances:install-progress` 实时显示在新建面板底部。自定义名称保存在 `%APPDATA%/mcdl-launcher-electron/instance-display-names.json`，不会伪造 `versions` 目录。

扫描缓存只记录用户主动扫描过的其他启动器目录；删除 `scanned-game-dirs.json` 即可恢复“只读自己的目录”。

当前限制：

- mcdl 只支持原版安装；Fabric / NeoForge / Forge / Quilt 下拉项保持禁用，等待后续接入。
- 启动已真实接入，见下文「真实启动」。

## IPC 通道

| 通道 | 方向 | 说明 |
| --- | --- | --- |
| `window:minimize` | renderer → main | 最小化 |
| `window:toggle-maximize` | renderer → main | 最大化 / 还原 |
| `window:close` | renderer → main | 关闭 |
| `window:is-maximized` | renderer → main | 查询最大化状态 |
| `instances:list` | renderer → main | 扫描自己的目录 + 已缓存的其他启动器目录 |
| `instances:scan-other` | renderer → main | 用户主动扫描 PCL/HMCL 并写缓存 |
| `versions:list` | renderer → main | 通过 mcdl 拉取正式版/快照/远古版列表 |
| `instances:create` | renderer → main | 调用 mcdl 安装原版到自己目录 |
| `instances:install-progress` | main → renderer | mcdl 安装输出 / 进度 |
| `shell:open-logs` | renderer → main | 打开应用日志目录（标题栏帮助按钮） |
| `launcher:launch` | renderer → main | 真实启动：拼 java 命令并拉起游戏进程 |
| `launcher:stop` | renderer → main | 结束当前启动的游戏进程 |
| `launcher:active` | renderer → main | 列出正在运行的游戏进程 |
| `accounts:list` | renderer → main | 账号列表（不含令牌） |
| `accounts:add-offline` | renderer → main | 创建并选中离线账号 |
| `accounts:add-microsoft` | renderer → main | 打开登录窗口并完成微软登录 |
| `accounts:select` / `accounts:remove` | renderer → main | 切换 / 删除账号 |
| `settings:get` / `settings:save` | renderer → main | 启动设置（内存 / Java / 窗口尺寸 / JVM 参数） |
| `window:maximized-changed` | main → renderer | 最大化状态广播 |
| `launcher:launch-progress` | main → renderer | 启动阶段：starting / spawned / output / exit / error |

渲染进程可用的 `window.launcherAPI`：

```js
window.launcherAPI.minimize();
window.launcherAPI.toggleMaximize();
window.launcherAPI.close();
window.launcherAPI.getInstanceInfo(); // { gameDir, instances, selectedId }
window.launcherAPI.getVersions(); // [{ id, date, type }]
window.launcherAPI.createInstance({ version, loader: 'Vanilla', name });
window.launcherAPI.onInstallProgress(({ message }) => {});
window.launcherAPI.openLogFolder();
window.launcherAPI.launchGame({ instanceId }); // 真实启动
window.launcherAPI.stopLaunch(launchId);
window.launcherAPI.onLaunchProgress(({ phase, ... }) => {});
window.launcherAPI.getAccounts();
window.launcherAPI.addOfflineAccount('Player');
window.launcherAPI.addMicrosoftAccount();
window.launcherAPI.selectAccount(id);
window.launcherAPI.removeAccount(id);
window.launcherAPI.getSettings();
window.launcherAPI.saveSettings({ memoryMb, width, height, jvmArgs, javaPath });
```

## L1 控件预留

根据 `mcdl-launcher/docs/ui-tree-controls.html` 的 L1 清单：

- 标题栏清单控件 6 个：帮助、最小化、关闭、返回、关闭当前页、刷新。
- 自定义无边框窗口额外需要最大化，因此实际显示 7 个标题栏按钮。
- 侧边栏 5 个：账户、游戏、实例列表、下载、设置。

标题栏的返回 / 刷新 / 关闭当前页 / 帮助位于左上；窗口最小化 / 最大化 / 关闭位于右上。侧边栏 5 项沿左边框垂直排列，当前默认激活「游戏」。

## 实例管理面板

点击左侧「实例列表」网格图标，主视区会淡出并切换到「新建实例」面板：

- 版本行右侧有类型下拉框：正式版 / 快照 / 远古版 / 全部
- 版本下拉框来自 `mcdl --list --type all` 的实时数据，默认筛选正式版
- 默认名称自动生成（`<版本> · 原版`），留空也可以直接创建
- 创建时调用 mcdl 安装到 MCDL Launcher 自己的游戏目录
- 加载器当前只有 Vanilla 可用，其他选项明确禁用
- 底部「扫描实例」按钮显式扫描 PCL/HMCL 位置；下方小字说明结果会缓存
- 扫描结果写入缓存，下次启动直接识别
- 返回 / Esc / 标题栏返回回到主视区

根据 `mcdl-launcher/docs/ui-tree-controls.html` 的 L2「实例管理」，面板底部保留：

| 控件 | key | 状态 |
| --- | --- | --- |
| 修改 | `button.edit` | 待接入（禁用） |
| 添加游戏文件夹 | `game_directory.new` | 待接入（禁用） |
| 全局游戏设置 | `settings.type.global.manage` | 待接入（禁用） |

右侧实例列表点击后会重新渲染「当前配置」卡；没有实例时配置卡和启动按钮隐藏。面板切换状态通过 `launcher:panel-change` 广播。

## 窗口拖拽

- BrowserWindow 使用 `frame: false`。
- 页面顶部 `.window-drag` 已设置 `-webkit-app-region: drag`。
- 右侧窗口控制按钮位于 `no-drag` 区域。
- Tauri 的 `data-tauri-drag-region` 仍保留，不影响 Electron。

## 安全边界

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- preload 只暴露白名单方法，不暴露 `ipcRenderer`。
- 主进程 IPC 校验发送方是否为当前应用窗口。
- 外部链接通过 `shell.openExternal` 打开，窗口内导航默认拦截。

## 数据与占位范围

- 实例列表、当前配置和主视区来自真实游戏目录，不再有 demo / test-data 回退。
- 默认只读取 `%APPDATA%/MCDL Launcher/.minecraft`，不自动定位 PCL/HMCL。
- 没有实例时：当前配置卡和启动按钮隐藏，实例列表显示空态，主视区显示 `NO INSTANCE`。
- 默认实例名称为 `<版本> · 原版`；名称输入框可以留空，不再强制填写。
- 新建实例会真实调用 mcdl 下载并写入自己的 `versions/<version>`。
- 用户点击「扫描实例」后，其他启动器目录写入缓存；之后启动自动读取缓存。
- 实例别名保存在应用 userData，不修改游戏文件；HMCL / PCL 仍看到原始版本 id。
- 新闻仍是占位；启动按钮上方的提示行现在显示真实启动状态（准备 / PID / 退出码 / 错误原因）。
- 启动依赖「账户」页选中的账号；没有账号时会在提示行说明，不会假装启动。
- 实例管理快捷项（修改 / 添加游戏文件夹 / 全局游戏设置）当前禁用并标记“待接入”，避免假点击。

外部后端仍可调用：

```js
window.updateInstanceUI(realData);
```

## 真实启动

`launcher:launch` 已经接入真实流程，不再占位。实现分为三个模块：

| 文件 | 职责 |
| --- | --- |
| `java-runtime.js` | 扫描并验证本机 Java（环境变量 / PATH / 常见安装目录 / `mcdl --list-java`），按版本要求挑选 |
| `version-manifest.js` | 读取并合并 `inheritsFrom` 链、求值 `rules`、解析 classpath 与 natives |
| `launch.js` | 解压 natives、下载缺失的 log4j 配置、替换 `${...}` 占位符、拉起 `javaw.exe` |

拼接顺序：

```text
<java> -Xmx<内存>M -Dfile.encoding=UTF-8 ...
       [版本 json 里 arguments.jvm 的条目（已求值 rules + 替换占位符）]
       <mainClass>
       [arguments.game 的条目]
```

支持的占位符包括 `auth_player_name`、`auth_uuid`、`auth_access_token`、`auth_session`、
`user_type`、`version_name`、`version_type`、`game_directory`、`assets_root`、`game_assets`、
`assets_index_name`、`natives_directory`、`launcher_name`、`launcher_version`、`classpath`、
`classpath_separator`、`library_directory`、`resolution_width`、`resolution_height`。

细节：

- `rules` 按官方语义求值（最后一条匹配的规则生效；无匹配即拒绝），`os.name` / `os.arch` / `features` 都参与判断。
- 1.12 及更早的 `minecraftArguments` 走空格切分（保留引号内空格）；1.13+ 走 `arguments.game`。
- 旧版 natives（library 带 `natives` 字段）解压 classifier jar；1.19+ 的独立 natives library 同样解压。
  解压用系统自带的 `tar.exe`（bsdtar 可读 zip），失败回退 PowerShell `Expand-Archive`。
- 客户端 jar 取 `jar` → 子版本 → 祖先里第一个真实存在的 jar。
- 资源索引 `assets/indexes/<id>.json` 缺失时直接报错，而不是启动后黑屏；
  索引里 `virtual: true` 的老版本会把 `--assetsDir` 指向 `assets/virtual/<id>`。
- 进程用同目录的 `javaw.exe` 启动，避免弹出控制台；stdout/stderr 同时写入
  `<gameDir>/logs/mcdl-launcher-<时间戳>.log` 并推给渲染进程。

启动按钮的行为：

- 点击后按钮进入 loading，`launcher:launch-progress` 依次推送 `starting` → `spawned`，拿到 PID 后按钮复位。
- 启动失败（缺账号、缺客户端 jar、缺资源索引、找不到 Java）会在按钮上方的提示行显示原因。
- 游戏退出后提示行显示退出码。

## 账户

`accounts.js` + 「账户」面板负责登录信息，账号保存在
`%APPDATA%/mcdl-launcher-electron/accounts.json`：

- **离线账号**：只要求玩家名（3-16 位字母 / 数字 / 下划线），UUID 用官方离线算法
  `md5("OfflinePlayer:<name>")` 生成。
- **微软账号**：应用内登录窗口走 Minecraft Live OAuth 授权码流程
  （`login.live.com/oauth20_authorize.srf`，client_id 是 Minecraft 的公开客户端 id），
  拿到 code 后换 `access_token`，再依次换 Xbox Live → XSTS → Minecraft 令牌，最后读 profile 获取真实 UUID。
  XSTS 的常见错误（未创建 Xbox 档案 / 地区不支持 / 未成年账号）会翻译成中文提示。
- 微软令牌过期前 5 分钟用 `refresh_token` 自动续期，失败则要求重新登录。
- 渲染进程只能拿到 `{ id, type, name, uuid, selected }`，令牌不出主进程。

## 设置

「设置」面板读写 `%APPDATA%/mcdl-launcher-electron/launcher-settings.json`：

| 项 | 说明 |
| --- | --- |
| 最大内存 | 512–32768 MB，直接影响 `-Xmx` |
| Java 运行时 | 默认「自动选择（按版本要求）」，也可固定某个 `java.exe` |
| 窗口宽 / 高 | 通过 `has_custom_resolution` 启用 `--width` / `--height` |
| 额外 JVM 参数 | 按空格切分后插在版本 json 的 jvm 参数之前 |

Java 自动选择规则：64 位优先 → 主版本号相同优先 → 否则取 `>= 要求` 里最小的主版本。

## 已验证

- 用真实安装的 `1.20.1` 跑通了 `buildLaunchPlan` + `launchInstance`：
  classpath 65 项、`assetsIndex=5`、无未替换占位符、无缺失库；
  启动后 `logs/latest.log` 出现 `Setting user: DevTester`、`Backend library: LWJGL version 3.3.1`、
  资源重载与音效初始化，说明已经进入主菜单。
- 离线账号的 401「Failed to verify authentication」是官方预期行为，不影响单人游戏。
- `Forge 47.4.0`（`BootstrapLauncher`）实例的 module-path 参数、`-DlibraryDirectory`、
  `--add-opens` 等也已按 json 正确拼接（`${primary_jar_name}` 由 Forge 自己在运行时替换）。
- 账户存储做过单元测试：离线 UUID 与官方一致（`Notch` → `b50ad385-829d-3141-a216-7e7d7539ba7f`）、
  非法玩家名被拒、令牌不会出现在渲染进程拿到的数据里。
- 渲染进程的 DOM 引用、`launcherAPI` 方法、IPC 通道做过静态一致性检查（19 个通道一一对应）。

> 注意：当前这台机器的终端会话里 Electron 创建窗口会以 `0xC0000005` 崩溃
> （`electron.exe --version` 正常，`--no-sandbox --version` 正常），所以 UI 截图与
> 真实窗口交互没法在这个会话内验证；上面的结论来自 node 层面的真实启动测试与静态检查。
> 在有正常桌面会话的机器上直接 `.\run-electron.ps1` 即可。

## 下一步

- 加载器安装（Fabric / NeoForge / Forge / Quilt）仍未接入，mcdl 只负责原版文件。
- 「下载中心」侧边栏项还没有面板，点击只切换高亮。
- 新闻区仍是占位。

