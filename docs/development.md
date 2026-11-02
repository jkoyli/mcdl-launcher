# 开发文档

面向需要修改本项目的人。使用说明见根目录 [README.md](../README.md)，
运行期问题的排查见 [troubleshooting.md](troubleshooting.md)。

## 技术栈与进程模型

- Electron 45（CommonJS），Node.js 20+ 运行时。
- 窗口 `frame: false`，标题栏、窗口控制与主视区全部由渲染进程自绘。
- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染进程只能访问
  preload 通过 `contextBridge` 暴露的 `window.launcherAPI`。
- 渲染进程只负责界面，所有文件系统与进程操作都在主进程完成。

## 目录与模块

```text
electron/
├── main.js               # 主进程：窗口、IPC 注册、启动协调
├── preload.js            # contextBridge 白名单（唯一渲染进程入口）
├── app-log.js            # 启动器日志落盘：console.* / 崩溃写 <userData>/logs/launcher-*.log
├── mcdl-service.js       # 调用 mcdl/mcdl.jar：目录探测、实例扫描、版本列表、安装
├── java-runtime.js       # 本机 Java 探测与版本挑选
├── java-install.js       # 从 Adoptium 下载 / 解压 JDK（安装 Java）
├── version-manifest.js   # 版本 JSON 解析：inheritsFrom / rules / classpath / natives
├── launch.js             # 真实启动：命令拼接、natives 解压、进程拉起
├── accounts.js           # 离线 / 微软 / authlib-injector 账号、认证服务器、离线皮肤
├── game-directories.js   # 用户添加的游戏文件夹
├── instance-store.js     # 实例级设置 / 图标 / 内容目录与内容管理
├── modrinth.js           # Modrinth 客户端：搜索、版本、必需前置、流式下载
├── modpack-export.js     # 导出整合包：扫描实例文件 + 写 manifest / modrinth.index + zip
├── nbt.js                # 最小 NBT 读写（level.dat，全部 12 种 tag + gzip）
├── nbt-editor.js         # NBT 编辑器：展平可编辑标量、按路径写回、备份 .bak
├── worlds.js             # 世界列表 / level.dat 读写 / 导出 / 备份 / 数据包
├── renderer/
│   ├── index.html        # 界面与样式（单文件内联 CSS）
│   └── renderer.js       # 渲染逻辑：主视区、实例面板、账户面板 + 弹窗、设置面板、下载中心
└── package.json          # 启动脚本与 electron 依赖
```

`mcdl/` 是内置的原版下载器（Java），由 `mcdl-service.js` 以子进程方式调用，详见下文「与 mcdl 的边界」。

## 启动流程

1. 渲染进程点击启动按钮 → `launcher:launch`（`{ instanceId }`）。
2. 主进程按 `instanceId` 在实例快照中定位实例，取出版本目录与游戏目录。
3. 读取当前账号；微软账号在过期前会自动刷新令牌。
4. `launch.js` 构造启动计划：
   - 读取版本 JSON 并沿 `inheritsFrom` 合并，根在前、子在后；
   - 按 `rules` 求值（`os.name` / `os.arch` / `features`，最后一条匹配的规则生效）；
   - 解析 classpath 与 natives，客户端 jar 取 `jar` → 子版本 → 祖先里第一个真实存在的；
   - 解压 natives 到 `versions/<id>/natives`；
   - 资源索引缺失时直接报错；`virtual: true` 的老版本使用 `assets/virtual/<id>`；
   - 替换版本 JSON 中的 `${...}` 占位符（账号、目录、classpath、分辨率等）。
5. `java-runtime.js` 按版本 `javaVersion.majorVersion` 选择 Java：64 位优先、主版本相同优先，
   否则取 `>=` 要求中最小的主版本；设置里可指定固定路径。
   **低版本 Java 会被拒绝**（手动指定与自动探测两条路径都是），不再只是打一行 warn。
6. **关键文件完整性闸门**（`launch-preflight.js`）：在 spawn 之前校验
   客户端 jar / 每个依赖库 / 每个 natives 包 / 资源索引 /（第三方账号的）authlib-injector。
   缺失或校验失败 → 抛 `LAUNCH_PREFLIGHT_FAILED`，**不拉起 Java**，并把结构化清单交给界面。
   校验强度：`auto`（默认，只对客户端 jar、资源索引、log4j、authlib 算 SHA-1；
   库与 natives 只查存在与非空）、`true`（全部算 SHA-1）、`false`（只查存在与非空）。
7. 主进程用 `javaw.exe` 拉起进程，stdout/stderr 写入
   `<gameDir>/logs/mcdl-launcher-<时间戳>.log`。
8. **等游戏窗口真的出现**（`game-window.js`）：spawn 只代表 Java 进程被创建，
   游戏还要加载资源 / 初始化 LWJGL / 加载模组才有窗口。Windows 上用一个长驻
   PowerShell 子进程轮询 `Get-Process -Id <pid>` 的 `MainWindowHandle`（非 0 即窗口已出现），
   不依赖任何原生模块；其它平台退化为已知日志标记，判不出来就按超时处理（不假装成功）。
   默认最多等 3 分钟；超时只表示「不再等」，不判定启动失败。
9. `exit` 事件额外带 `stopped`（是否是用户手动结束）、`logFile` 与 `crashReport`
   （本次启动后新出现的 `<gameDir>/crash-reports/*.txt`），以及 `earlyFailure`
   （启动后 15 秒内非 0 退出且无崩溃报告）。渲染层据此决定是否弹「游戏崩溃窗口」。

实例查找统一走 `rescanInstances()`（启动器目录 + 用户添加的游戏文件夹 + 已缓存的其他启动器），
所以从「添加游戏文件夹」加进来的实例也能直接启动 / 生成脚本。

### 启动进度事件（`launcher:launch-progress`）

界面上的「启动游戏」进度窗口只显示**引擎真的做了的事**，没有任何占位步骤。事件契约：

| phase | 含义 |
|---|---|
| `begin` | 启动真正开始（还没 spawn），带 `launchId`；界面据此打开进度窗口并允许取消 |
| `stage` | 某一步的状态变化：`{ stage, state: 'running'\|'done'\|'failed', detail }` |
| `spawned` | Java 进程已创建（`pid` / `logFile`） |
| `output` | 游戏输出（日志窗口实时续上） |
| `preflight-failed` | 闸门拦下了这次启动，带缺失清单；界面切到「实例文件不完整」 |
| `exit` / `error` | 进程退出 / 启动失败 |

`stage` 的取值与顺序对应代码里的实际动作：

```text
account → instance → java → libraries → natives → logging(可选) → assets
        → args → authlib(仅第三方账号) → verify → spawn → window
```

`detail` 是真实数据（Java 主版本与路径、依赖库数量、资源索引文件名、
`检查 N 项（M 项比对 SHA-1…）`、PID…）。没做的步骤不会出现
（例如离线账号没有 `authlib`，没有 natives 的版本只有一条「没有需要解压的 natives」）。

`window` 是最后一步、也是唯一能代表「启动完成」的一步：等待期间每秒更新一次
`已等待 N 秒 · 最近输出：<游戏日志最后一行>`，检测到窗口后变成
`游戏窗口已出现（用时 N 秒）`，超时则变成 `180 秒内没有检测到游戏窗口…`（两者都用 `done`，
区别写在 detail 里，界面据此决定用成功色还是中性色）。

**取消**：`launcher:stop` 在规划/校验阶段走 `AbortController`（`launch.js` 在每个阶段边界
用 `throwIfCancelled` 检查），保证取消后**不会**留下 Java 进程；spawn 之后则是结束进程，
界面在等待窗口期间把按钮文案换成「停止游戏」。


命令拼接顺序：

```text
<java> -Xmx<内存>M -Dfile.encoding=UTF-8 ...
       [版本 JSON 的 arguments.jvm（已求值 rules 与占位符）]
       <mainClass>
       [版本 JSON 的 arguments.game]
```

版本 JSON 未提供 `arguments.jvm` 时（1.12 及更早），由启动器补 `-Djava.library.path` 与 `-cp`；
游戏参数优先取 `arguments.game`，否则切分 `minecraftArguments`。

## 账户流程

账号保存在 `accounts.json`，渲染进程只拿到 `{ id, type, name, uuid, selected }`，令牌不出主进程。

**离线账号**：仅需玩家名（1–16 位字母、数字、下划线），UUID 按官方离线算法
`md5("OfflinePlayer:<name>")` 生成，`accessToken` 传 `0`、`userType` 传 `legacy`。

**微软账号**：

1. 应用内登录窗口打开 `login.live.com/oauth20_authorize.srf`（client_id 为 Minecraft 公开客户端 id）；
2. 拦截跳回的 `oauth20_desktop.srf`，取出 `code`；
3. `code` → Microsoft `access_token` / `refresh_token`；
4. `access_token` → Xbox Live → XSTS → Minecraft `access_token`；
5. `/minecraft/profile` 取真实 UUID 与玩家名。

令牌过期前 5 分钟用 `refresh_token` 续期；XSTS 常见错误（未创建 Xbox 档案、地区不支持、
未成年账号）会翻译成可读提示。

**第三方账号（authlib-injector）**：

1. 「添加认证服务器」向导先 `GET <apiRoot>` 读取 Yggdrasil 元数据
   （必须有 `signaturePublickey` 或 `meta`），成功后把 `{ apiRoot, name }` 存进 `accounts.json` 的 `servers`；
2. 「正版登录」页签用用户名 / 密码 POST `<apiRoot>authserver/authenticate`，
   取 `accessToken` 与 `selectedProfile`（没有角色时提示先去服务器网站创建）；
3. 启动该账号的实例时，`launch.js` 会把 authlib-injector 作为 `-javaagent` 注入：
   本地没有 jar 时按官方 `latest.json` 下载到数据目录 `authlib-injector/authlib-injector.jar` 并缓存；
4. 参数用 `userType=mojang`，`-javaagent:<jar>=<apiRoot>` 追加在 `arguments.jvm` 之后、主类之前。

**离线皮肤**：选择 PNG（校验文件头与尺寸 64×64 / 64×32 及其高清倍数）后复制到
数据目录 `skins/`，记录 `classic` / `slim` 模型。目前只做保存与预览——游戏内生效需要
自定义皮肤服务，暂未注入。

**账号卡片与头像**：账户以卡片展示，左上角标签标明类型（微软 / 离线 / 第三方），
下方一行写明账户类型与服务器名。头像按以下顺序取：

1. 本机皮肤文件（离线账号手动选的）；
2. 微软账号：登录时 `/minecraft/profile` 返回的 `skins[].url`，老账号在首次渲染时补拉；
3. 第三方账号：`<apiRoot>sessionserver/session/minecraft/profile/<uuid>` 里
   `textures` 属性的 base64 JSON；
4. 都拿不到时用玩家名哈希生成的像素头像。

远程皮肤由主进程下载并缓存在 `skins/remote-<账号>-<url 哈希>.png`，有效期 6 小时，
失败时退回旧缓存。卡片 `⋯` 菜单里的「刷新皮肤」会清掉缓存的皮肤地址重新拉取。

## 与 mcdl 的边界

`mcdl` 只负责原版 Minecraft 文件的下载与安装，启动器负责账号、参数与进程。调用方式：

```text
<java> -Dfile.encoding=UTF-8 -jar mcdl/mcdl.jar <args>
```

| 用途 | 参数 |
| --- | --- |
| 版本列表 | `--list --type all` |
| 安装原版 | `--install <version> --dir <gameDir> --source auto --jobs 16` |
| 加载器版本列表 | `--list-loaders <fabric\|quilt\|forge\|neoforge> --mc <version>`（stdout 只有 JSON） |
| 安装加载器 | `--install-loader <loader> --mc <version> [--loader-version <v>] [--name <实例名>] --dir <gameDir>` |
| 探测其他启动器目录 | `--list-dirs` |
| 探测本机 Java | `--list-java` |

加载器安装由 `mcdl/core/Loaders.java` 实现，三条路径：

- **Fabric / Quilt** — 直接取 meta 的 profile JSON（已含 `libraries` 与 `mainClass`），
  写入 `versions/<实例名>/<实例名>.json` 并补齐 maven 库，不需要跑安装器。
- **Forge 1.12+ / NeoForge** — 下载官方 `-installer.jar`，用 `--installClient <gameDir>`
  静默安装（先补一个 `launcher_profiles.json`），再写一层 `inheritsFrom` 指向安装器生成的版本。
- **Forge 1.7.10 一类老安装器** — 只有 Swing 界面、没有静默模式，改为读安装器 zip 里的
  `install_profile.json`：写出 `versionInfo`、释放内嵌 universal jar 到 `libraries/`，再补下载其中的库。

NeoForge 的版本号反推 MC 版本按 HMCL 的规则处理（`21.1.9` → 1.21.1，`21.0.167` → 1.21，
`20.4.x` → 1.20.4；1.20.1 走 `net.neoforged:forge` 的 47.1.x）。
OptiFine 需要官网安装器（没有稳定的机器可读列表），LiteLoader 停在 1.12.2，两者不提供自动安装。

`mcdl/README.md` 为上游原始文档；本仓库对它的集成说明见下一节「数据文件」。

## 渲染策略

界面大量使用 `backdrop-filter` 与渐变动画，走 CPU 合成时单帧成本约 40–50ms（实测 21–24fps），
硬件加速下可稳定 60fps。因此默认启用硬件加速，并为崩溃设备保留回退：

| 触发条件 | 结果 |
| --- | --- |
| 默认 | 硬件加速 |
| `MCDL_RENDER=software`、`MCDL_DISABLE_GPU=1` 或 `--software-render` | 强制软件渲染 |
| `MCDL_RENDER=gpu` | 强制硬件加速，忽略崩溃记录 |
| 上次运行 GPU 子进程崩溃（7 天内） | 自动软件渲染 |

GPU 子进程崩溃时，主进程写入 `gpu-crash.json` 并以 `--software-render` 重启一次；重启后的进程
不会再走这条路径，因此不会循环。删除该文件（或设置 `MCDL_RENDER=gpu`）即可恢复硬件加速。

软件渲染时，渲染进程会给 `body` 加 `.is-software`，由 CSS 关闭全部 `backdrop-filter`、
停掉极光层的 `background-position` 动画，并用半透明底色替代毛玻璃，避免每帧重算背景。

## 数据目录

Electron 的 `userData` 默认是 `%APPDATA%\mcdl-launcher-electron`。启动时会先做一次写探针
（`.write-probe`），不可写就按顺序回退：

```text
MCDL_USER_DATA（环境变量，最高优先）
→ %APPDATA%\mcdl-launcher-electron
→ %LOCALAPPDATA%\mcdl-launcher-electron
→ <程序目录>/data
→ %TEMP%\mcdl-launcher-electron
```

选中的路径会在启动日志里打印：

```text
[data] userData: C:\Users\<user>\AppData\Roaming\mcdl-launcher-electron
```

之所以要回退：少数机器上安全软件策略或受限会话会让 Electron 进程没有该目录的写权限，
表现为账号、设置、Chromium 缓存全部写入失败（`accounts.json` 的 `EPERM`）。

## 数据文件

| 路径 | 内容 |
| --- | --- |
| `%APPDATA%\MCDL Launcher\.minecraft` | 游戏目录（`versions/`、`libraries/`、`assets/` 等） |
| `%APPDATA%\mcdl-launcher-electron\accounts.json` | 账号、令牌与已添加的认证服务器 |
| `%APPDATA%\mcdl-launcher-electron\skins\<账号>.png` | 离线皮肤文件 |
| `%APPDATA%\mcdl-launcher-electron\authlib-injector\authlib-injector.jar` | 第三方账号启动用的 java agent（按需下载并缓存） |
| `%APPDATA%\mcdl-launcher-electron\launcher-settings.json` | 内存 / Java / 窗口尺寸 / 额外 JVM 参数 |
| `%APPDATA%\mcdl-launcher-electron\instance-display-names.json` | 实例别名 |
| `%APPDATA%\mcdl-launcher-electron\game-directories.json` | 已添加的游戏文件夹（含相对路径开关与 primary 标记） |
| `%APPDATA%\mcdl-launcher-electron\java-runtimes.json` | 本机 Java 扫描结果缓存（24 小时） |
| `%APPDATA%\mcdl-launcher-electron\launch-scripts\` | 实例目录不可写时的启动脚本落点 |
| `%APPDATA%\mcdl-launcher-electron\instance-settings.json` | 实例级内存 / Java / 窗口 / JVM 参数覆盖 |
| `%APPDATA%\mcdl-launcher-electron\instance-icons.json` | 实例图标（内置 key 或自定义图片文件名） |
| `%APPDATA%\mcdl-launcher-electron\icons\` | 自定义图标图片 |
| `%APPDATA%\mcdl-launcher-electron\scanned-game-dirs.json` | 主动扫描过的其他启动器目录 |
| `%APPDATA%\mcdl-launcher-electron\world-backups\<saves 哈希>\<世界>__<时间戳>.zip` | 世界备份 |
| `%APPDATA%\mcdl-launcher-electron\java\temurin-<主版本>\` | 「安装 Java」下载的 JDK |
| `%APPDATA%\mcdl-launcher-electron\logs\launcher-<日期>.log` | 启动器自身日志（主进程输出 / 崩溃） |
| `%APPDATA%\mcdl-launcher-electron\gpu-crash.json` | 最近一次 GPU 崩溃记录（存在时下次启动走软件渲染） |
| `<gameDir>\logs\mcdl-launcher-<时间戳>.log` | 每次启动的完整输出 |
| `<gameDir>\logs\latest.log` | 游戏自身的日志 |

可用环境变量覆盖默认值：

| 变量 | 作用 |
| --- | --- |
| `MCDL_GAME_DIR` | 游戏目录 |
| `MCDL_USER_DATA` | 账号 / 设置所在的数据目录（覆盖自动选择） |
| `MCDL_JAR` | `mcdl.jar` 路径 |
| `MCDL_JAVA` | 运行 `mcdl.jar` 的 Java |
| `MCDL_RENDER` | `gpu` 或 `software`，覆盖渲染策略 |
| `MCDL_DISABLE_GPU` | 设为 `1` 时禁用硬件加速（等价于 `MCDL_RENDER=software`） |
| `MCDL_MSA_CLIENT_ID` | 覆盖微软登录使用的 client id |

## IPC 通道

| 通道 | 方向 | 说明 |
| --- | --- | --- |
| `window:minimize` | renderer → main | 最小化 |
| `window:toggle-maximize` | renderer → main | 最大化 / 还原 |
| `window:close` | renderer → main | 关闭 |
| `window:is-maximized` | renderer → main | 查询最大化状态 |
| `window:maximized-changed` | main → renderer | 最大化状态广播 |
| `instances:list` | renderer → main | 扫描实例（自身目录 + 已添加的游戏文件夹 + 已缓存的其他启动器） |
| `instances:scan-other` | renderer → main | 主动扫描 PCL / HMCL 并写缓存 |
| `versions:list` | renderer → main | 通过 `mcdl --list` 拉取版本列表 |
| `downloads:versions` | renderer → main | 下载中心的版本目录：`{ versions, latestRelease, latestSnapshot }`，`force` 绕过 10 分钟缓存 |
| `downloads:pick-pack` | renderer → main | 选择整合包（`.zip` / `.mrpack`）并返回预览（条目数 / mod 数 / 前 60 个条目） |
| `downloads:inspect-pack` | renderer → main | 按已知路径读取整合包预览 |
| `downloads:install-pack` | renderer → main | 调用 `mcdl --install-pack` 安装整合包，返回实例 id + 新快照 |
| `downloads:addon-search` | renderer → main | Modrinth 搜索：`{ kind, query, gameVersion, loader, sort, offset }` |
| `downloads:addon-versions` | renderer → main | 某项目的版本列表，按游戏版本 / 加载器过滤 |
| `downloads:install-addon` | renderer → main | 下载所选版本（可选必需前置）到实例内容目录 |
| `downloads:save-addon` | renderer → main | 选一个文件夹，只下载到本地 |
| `downloads:addon-progress` | main → renderer | 内容下载进度（单个文件 / 前置 N/M） |
| `downloads:progress` | main → renderer | 整合包安装输出 / 进度 |
| `instances:create` | renderer → main | 调用 `mcdl --install` / `--install-loader` 安装原版或加载器（`assets: false` 时加 `--no-assets`） |
| `instances:install-progress` | main → renderer | 安装输出 / 进度 |
| `instances:rename` | renderer → main | 重命名实例别名（写 `instance-display-names.json`） |
| `instances:duplicate` | renderer → main | 复制实例目录为「… - 副本」 |
| `instances:remove` | renderer → main | 删除 `versions/<id>` 目录（仅限 versions 下） |
| `instances:open-folder` | renderer → main | 在资源管理器中打开实例运行目录 |
| `instances:launch-script` | renderer → main | 生成 `启动-<版本>.ps1/.bat`；实例目录不可写时落到数据目录 |
| `instances:settings` / `instances:save-settings` | renderer → main | 实例级设置的读取 / 覆盖保存（空值=继承全局） |
| `instances:icon-get` / `icon-set-builtin` / `icon-pick` / `icon-clear` | renderer → main | 实例图标：读取 / 内置 / 选本地图片 / 恢复默认 |
| `instances:content-list` / `content-toggle` / `content-delete` / `content-import` / `content-folder` | renderer → main | 模组 / 资源包 / 世界 / 原理图的列表、启停、删除、导入、打开文件夹 |
| `gamedirs:list` / `gamedirs:save` / `gamedirs:remove` | renderer → main | 游戏文件夹增删改（含相对路径开关） |
| `gamedirs:pick` | renderer → main | 打开「选择文件夹」对话框 |
| `launcher:launch` | renderer → main | 构造命令并启动游戏；`{ test: true }` 为测试启动（同时打开日志） |
| `launcher:preflight` | renderer → main | 启动前完整性检查（不启动）：`{ ok, checked, failures[], warnings }` |
| `launcher:repair` | renderer → main | 按闸门清单重新下载缺失 / 损坏的文件并复检 |
| `launcher:stop` | renderer → main | 结束正在运行的游戏进程；规划 / 校验阶段则中止本次启动（不 spawn） |
| `launcher:active` | renderer → main | 列出运行中的游戏进程 |
| `launcher:launch-progress` | main → renderer | 启动阶段与游戏输出；`exit` 里带 `stopped` / `logFile` / `crashReport` / `earlyFailure` |
| `recovery:reload` / `reset-workspace` / `export-diagnostics` | renderer → main | 崩溃恢复页的三个出口（重新加载 / 重置界面缓存 / 导出诊断） |
| `logs:tail` | renderer → main | 日志窗口快照：最近一次启动日志（或该游戏目录下最新一份）的尾部 + 是否运行中 |
| `logs:export` | renderer → main | 把日志视图（或指定文本）另存为文件，并定位到资源管理器 |
| `logs:open-folder` | renderer → main | 打开日志文件夹：`scope=app`（启动器日志）/ `game`（`<gameDir>/logs`） |
| `logs:dump` | renderer → main | 导出游戏运行栈：优先 `jstack -l <pid>`，没有 jstack 时退回启动器侧信息 + 日志尾部 |
| `crash:export` | renderer → main | 导出游戏崩溃信息（崩溃报告 + 日志尾部打包）；只接受该游戏目录下 `crash-reports` / `logs` 内的路径 |
| `ui:copy-text` | renderer → main | 写系统剪贴板（`file://` 下 `navigator.clipboard` 不可靠） |
| `launcher:crash` | main → renderer | 主进程 `uncaughtException` / `unhandledRejection`，渲染层弹崩溃窗口 |
| `accounts:list` | renderer → main | 账号列表（不含令牌） |
| `accounts:add-offline` | renderer → main | 创建并选中离线账号 |
| `accounts:add-microsoft` | renderer → main | 打开登录窗口并完成微软登录 |
| `accounts:select` / `accounts:remove` | renderer → main | 切换 / 删除账号 |
| `accounts:servers` | renderer → main | 认证服务器列表 |
| `accounts:add-server` | renderer → main | 校验并添加 authlib-injector 服务器 |
| `accounts:remove-server` | renderer → main | 删除服务器（连带依赖它的账号） |
| `accounts:login-authlib` | renderer → main | 用户名 / 密码登录第三方服务器 |
| `accounts:pick-skin` | renderer → main | 打开文件选择并校验皮肤 PNG |
| `accounts:set-skin` | renderer → main | 保存皮肤与模型 |
| `accounts:set-skin-model` | renderer → main | 只切换经典 / 纤细模型 |
| `accounts:clear-skin` | renderer → main | 删除皮肤文件 |
| `accounts:skin-data` | renderer → main | 读取皮肤 PNG 的 data URL（预览） |
| `settings:get` / `settings:save` | renderer → main | 读取 / 保存启动设置（含下载源、隔离策略、动画开关、游戏设置预设 `presets`） |
| `settings:preferences` | renderer → main | 启动时只读偏好，不触发 Java 扫描（用于恢复「关闭动画」） |
| `java:install` | renderer → main | 从 Adoptium 下载并安装指定主版本 JDK，登记授权后返回 `{ path, info }` |
| `java:install-progress` | main → renderer | Java 下载 / 解压进度 |
| `nbt:pick` | renderer → main | 选 NBT 文件并返回一次性 token + 展平后的行；token 30 分钟有效 |
| `nbt:save` | renderer → main | 只接受 token，按路径写回标量字段（先备份 `.bak`） |
| `instances:screenshots` | renderer → main | 截图列表（data URL，单张 ≤16 MB、总量 ≤160 MB） |
| `screenshots:copy` | renderer → main | 截图写入系统剪贴板 |
| `screenshots:set-wallpaper` | renderer → main | 截图设为启动器背景（复用壁纸导入管线） |
| `instances:maintenance` | renderer → main | 实例维护：`clean` / `remove-assets` / `remove-libraries` / `redownload-assets`（`--assets-only --verify`） |
| `instances:merge-pack` | renderer → main | 更新整合包：把同目录下的临时实例合并进目标实例并删除临时实例 |
| `modpack:scan` | renderer → main | 导出向导：扫描实例可导出的文件夹 / 文件 / 大小 |
| `modpack:export` | renderer → main | 导出向导：选保存位置后打包 zip（临时文件写入 → 成功后改名） |
| `modpack:export-progress` | main → renderer | 导出进度（收集 / 写清单 / 压缩） |
| `app:info` | renderer → main | 关于页：版本 / Electron / Node / 平台 / 数据目录 / 仓库地址 |
| `worlds:list` / `worlds:info` | renderer → main | 世界列表（读 level.dat）/ 单个世界信息 |
| `worlds:save-info` | renderer → main | 写入 level.dat（作弊 / 生成建筑 / 难度 / 锁定 / 模式） |
| `worlds:delete` / `worlds:duplicate` | renderer → main | 删除 / 复制世界目录 |
| `worlds:export` | renderer → main | 选保存路径后把世界目录打包成 zip |
| `worlds:open-folder` | renderer → main | 打开世界目录 |
| `worlds:backups` / `backup-create` / `backup-restore` / `backup-delete` | renderer → main | 世界备份的列表 / 创建 / 恢复 / 删除 |
| `worlds:open-backup-folder` | renderer → main | 打开该存档目录的备份文件夹 |
| `worlds:datapacks` / `import-datapack` / `delete-datapack` | renderer → main | 数据包列表 / 导入 / 删除 |
| `ui:context-menu` | renderer → main | 文本框原生右键菜单（撤销/重做/剪切/复制/粘贴/删除/全选），编辑动作走 Chromium role |
| `task:cancel` | renderer → main | 取消长任务：abort 对应 `taskId`，mcdl 子进程被 kill、下载 fetch 中断 |
| `shell:open-logs` | renderer → main | 打开应用日志目录 |

主进程用 `assertAppWindow()` 校验调用方是否为当前应用窗口，其他来源的调用一律拒绝。

长任务（安装原版 / 加载器 / 整合包、Modrinth 下载）的 `payload.taskId` 由渲染层的
`runTask()` 生成；主进程把它登记进 `activeTasks`（`AbortController`），`task:cancel`
一到就 abort。窗口关闭时 `cancelAllTasks()` 会把这些进程一起停掉。

## 渲染层共享基座

`renderer.js` 里有几块通用组件，新页面直接复用，不要在页面里再抄一份：

| 基座 | 位置 | 负责 | 已迁移 |
| --- | --- | --- | --- |
| `createTabs({ tabAttr, panelAttr, onChange })` | 共享组件基座 | `aria-selected` / `is-active` / roving tabindex / ←→ Home End / 焦点 / 面板 `hidden` | 设置 6、实例详情 6、世界 3、下载 6 页签 |
| `createList({ container, itemKey, renderRow, emptyState, countEl, onSelect })` | 共享组件基座 | 列表行渲染 / 选中（`is-selected`）/ 空态 / 计数 | 游戏文件夹列表 |
| `createToolbar` | — | 搜索 + 筛选 + 计数 | 暂未抽出（下载 / 世界 / 实例三处工具栏仍是各自实现，等新页面再统一） |

通用对话框（`renderer.js` 弹窗管理一节）：

| API | 用法 |
| --- | --- |
| `askConfirm(text, onConfirm, okText)` | 确认框（原有） |
| `askPrompt({ title, text, label, value, placeholder, okText, maxLength, required })` | 输入框，`Promise<string\|null>`；留空会在对话框内提示，取消得到 `null` |
| `runTask({ title, status, cancelable, run, doneText })` | 长任务进度框；`run(ctx)` 里把 `ctx.taskId` 传给 IPC，取消会真正中断 |

`askPrompt` 目前用于：实例重命名（实例右键菜单 / 实例操作对话框）、复制实例命名、
世界重命名（世界右键菜单）。`runTask` 用于：安装实例（原版 / 加载器）、安装整合包。


## 界面结构

```text
窗口（frame: false）
├── 标题栏  左：返回 / 刷新 / 关闭当前页 / 帮助（打开日志目录）
│           右：最小化 / 最大化 / 关闭
├── 侧边栏  账户 / 游戏 / 实例列表 / 下载中心 / 设置
├── 主视区  主视觉（版本名、3D 方块） + 更新日志区
│           ├── 二级页面：实例列表  →  游戏目录管理 ／ 新建实例 ／ 实例操作弹窗
│           ├── 二级页面：账户  →  5 个 L5 弹窗
│           └── 二级页面：设置
└── 右侧控制台  实例列表 / 当前配置 / 启动按钮
```

二级页面统一由 `renderer.js` 的页面栈管理（`showPanel` / `hideActivePanel` / `closeActivePanel`）：
主视区上只加一个 `is-xxx` 类，其余面板保持 `inert`；「返回 / 关闭当前页」和 Esc 走同一个出口，
游戏目录页返回时回到实例列表而不是主视区。

### 实例列表页（对照 [L2] 实例管理）

| 控件 | control key | 行为 |
| --- | --- | --- |
| 修改 | `button.edit` | 打开实例操作弹窗（重命名 / 复制 / 删除） |
| 添加游戏文件夹 | `game_directory.new` | 打开游戏目录管理页（新增模式，表单为空） |
| 全局游戏设置 | `settings.type.global.manage` | 跳到设置页并高亮表单 |
| 实例行 | 运行时 | 单击选中（只同步选中态，不重建行，保证双击有效）；**双击进入实例详情**（启动走右下角「启动游戏」或菜单「启动游戏」）；`⋯` 或右键打开实例菜单 |

实例右键菜单 7 项（清单里归在共享分支的 `GameListCell`）：

| 菜单项 | 行为 |
| --- | --- |
| 启动游戏 | 用当前账号启动该实例 |
| 测试游戏 | 启动并把本次启动日志打开 |
| 生成启动脚本 | 生成 `启动-<版本>.ps1` + `.bat` 到实例目录 |
| 重命名该实例 | 打开实例操作弹窗 |
| 复制游戏实例 | 复制 `versions/<id>` 为「… - 副本」 |
| 删除该实例 | 二次确认后删除 `versions/<id>` |
| 导出整合包 | 待接入（禁用） |
| 实例运行文件夹 | 打开实例的游戏目录 |

### 游戏目录管理（对照 [L4] GameDirectoryPage）

独立的二级页面，不是弹窗。两个入口：「添加游戏文件夹」传空（新增），列表里点某一项进编辑模式。

| 控件 | key | 行为 |
| --- | --- | --- |
| 路径输入 + 浏览 | — | 手动填或系统选择框 |
| 若可能，游戏文件夹使用相对路径 | `game_directory.use_relative_path` | 只有位于启动器目录内的文件夹可勾选，否则开关禁用 |
| 保存 | `button.save` | 校验路径、补齐标准结构（失败也照常加入）、刷新实例列表 |
| 删除该文件夹 | — | 从列表移除，不动磁盘文件；主目录不给删 |

已管理目录存在 `game-directories.json`；`primary` 目录是安装落点，其余目录的实例以「外部」标记参与扫描。

### 实例详情（对照 [L3] 实例详情：7 页签）

入口三个：实例列表右键菜单「实例详情」、右侧「当前配置」卡、实例操作弹窗里的入口。

| 页签 | key | 内容 |
| --- | --- | --- |
| 游戏设置 | `settings.game` | 实例级内存 / Java / 窗口宽高 / 额外 JVM 参数；留空 = 继承全局，占位符显示全局值 |
| 自动安装 | `settings.tabs.installers` | Forge / NeoForge / Fabric / Quilt 可安装（`loaders:list` + `instances:create`，实例目录为当前实例所在目录）；LiteLoader / OptiFine 仍为禁用占位 |
| 模组管理 | `mods.manage` | 搜索、分页（每页 80 + 显示更多）、全选 / 多选、批量启用 / 批量禁用 / 批量删除、定位文件（资源管理器选中）、导入、刷新、打开文件夹；「检查更新」为禁用占位 |
| 资源包 | `resourcepack.manage` | 搜索、分页、多选、批量删除、定位文件、导入、刷新、打开文件夹（启用状态需改 `options.txt`，未接入） |
| 世界 | `world.manage` | 世界列表（图标 / 版本 / 模式 / 难度 / 大小 / 时间）＋管理页：世界信息（读写 level.dat）、备份管理、数据包管理 |
| 截图（第 7 页签） | `screenshots.manage` | 截图网格（搜索 / 刷新 / 打开文件夹）；点开查看器：设为启动器背景 / 复制到剪贴板 / 确定 |
| 原理图 | `schematics.manage` | 搜索、分页、多选、批量删除、定位文件、导入（schematic / schem / nbt / litematic）、刷新 |

左侧 4 个导航项（对照 `GameInstancePage.java:403-410`）：

| 导航项 | 行为 |
| --- | --- |
| 更新整合包 | 选新版整合包 → `downloads:install-pack` 装到同游戏目录的临时实例 `update-<stamp>` → `instances:merge-pack` 覆盖合并 → 删除临时实例 |
| 测试游戏 | 启动并把本次日志窗口打开（与实例菜单的「测试游戏」同一流程） |
| 浏览 | 弹出 10 个文件夹快捷入口（与底部 chip 同一套动作） |
| 管理 | 弹出 5 项：截图管理（切到截图页签）/ 更新游戏资源文件（`--assets-only --verify`）/ 删除所有游戏资源文件 / 删除所有库文件 / 清理游戏文件夹（logs + crash-reports + natives + 断点状态）；另加清单外「查看日志」 |

`清理 / 删资源 / 删库` 都会先弹二次确认；`更新游戏资源文件` 走 `runTask`，可取消。

内容目录按「版本隔离」解析：`versions/<id>/<子目录>` 存在就用它（HMCL / PCL 装整合包的做法），
否则回落到 `<游戏目录>/<子目录>`；两者都不存在时，外部实例按版本目录新建、自己的实例按全局目录新建。
页签里会显示实际使用的目录，避免「明明有模组却看不到」。
内容页签的工具栏统一由 `renderContentPanel()` 生成：搜索框（按名字过滤）、`全选`（作用于当前过滤结果的全部条目）、
`批量启用 / 批量禁用`（仅模组）、`批量删除`、`定位文件`（有选中时 `shell.showItemInFolder` 定位到文件，否则打开目录）、
`打开文件夹`、`检查更新`（虚线禁用占位）、`导入`（世界页签不提供）、`刷新`。
列表默认渲染 80 行，`显示更多` 每次追加 80；计数显示 `共 N` / `匹配 M / 共 N`，有选中时追加 `已选 K`。
页面底部是 10 个文件夹快捷入口：实例运行目录、`config`、`mods`、`resourcepacks`、`saves`、
`schematics`、`shaderpacks`、`screenshots`、`logs`、`crash-reports`。
详情页打开时右侧控制台自动收起（`body[data-panel="detail"]`），避免压住表单。

### 实例图标（对照 [L5] GameInstanceIconDialog）

头像按钮（详情页左上）或实例菜单「更换图标」打开，含三部分：6 个内置图标（等距方块，纯内联 SVG）、
「选择本地图片…」（PNG/JPG/WebP/GIF，≤4 MB，复制到 `icons/` 并记 data URL）、「恢复默认」。
图标只影响启动器显示，不写游戏文件；实例行、详情页头像都跟着变。

### 实例级设置

`instance-settings.json` 以版本目录为 key 存覆盖项（`memoryMb` / `width` / `height` / `jvmArgs` / `javaPath`）。
启动、生成启动脚本、设置页都用 `effectiveSettings()` 合并：**实例覆盖 > 全局设置 > 自动探测**，
Java 路径也按这个顺序挑（`resolveJavaRuntime({ javaPath })`）。

### 下载中心（对照 [L2] 下载）

侧边栏「下载」进入独立的二级页面（`stageDownload`）。布局沿用其他二级页：左侧大标题，右侧
`download-body`（6 个页签 + 内容区）。页签与清单一一对应：`游戏` / `整合包` / `模组` / `资源包` /
`光影` / `世界`。前两个走 `mcdl`，中间三个走 Modrinth；「世界」没有可用在线源，保留占位。

**游戏页签**（对照 [L3] 游戏版本 与 [L4] 安装向导 · 可选文件）：

| 控件 | control key | 行为 |
| --- | --- | --- |
| 版本卡片 | 运行时 | 打开「安装 · 可选文件」弹窗并带上该版本；已安装的版本卡标「已安装」 |
| 最新正式版 / 最新快照 | 运行时 | 两张固定卡片，版本号取自 `mcdl --list` 的列表头 |
| 搜索框 | `search` | 按版本号 / 日期过滤，最多渲染 240 张卡片 |
| 版本类型 | — | 正式版 / 快照 / 远古版 / 全部 |
| 刷新 | `button.refresh` | `downloads:versions { force: true }`，清掉 mcdl-service 的 10 分钟缓存 |
| 加载器 / 加载器版本 | — | 选非 Vanilla 时用 `loaders:list` 拉取构建列表 |
| 实例名称 | — | 留空按 `<版本> · <加载器>` 自动生成 |
| 可选文件 · assets | — | 取消勾选时给 `--install` 加 `--no-assets`，只装版本与库 |
| 安装 | `button.install` | `instances:create`；成功后关闭弹窗、刷新实例，并（默认）跳到实例列表 |

安装期间弹窗不可关闭（Esc、取消、右上角 × 都被拦截），进度来自 `instances:install-progress`。

**整合包页签**（对照 [L3] 整合包 与 [L4] 整合包类型选择）：

| 控件 | control key | 行为 |
| --- | --- | --- |
| 本地整合包 / Modrinth / CurseForge | — | 只有「本地整合包」可用，另两个标待接入并禁用 |
| 选择文件 | — | `downloads:pick-pack`：系统选择框 + 读 zip 中央目录做预览 |
| 可选文件 | `modpack.optional_files` | 弹窗列出包内前 60 个条目（mcdl 会解压全部内容，这里只做预览） |
| 安装 | `button.install` | `downloads:install-pack` → `mcdl --install-pack <file> --dir <游戏目录> [--name]` |

zip 预览不依赖第三方库：`mcdl-service.js` 的 `readZipEntries()` 只读文件尾部的中央目录，
条目名同时接受 `/` 与 `\`（Windows 打出来的 zip 用反斜杠），并识别 `modrinth.index.json` /
`manifest.json`、`mods/`、`overrides/`。

**内容页签**（对照 [L3] 内容列表 与 [L4] 内容下载页）：模组 / 资源包 / 光影共用同一套列表与弹窗，
入口是 `electron/modrinth.js`。

| 控件 | control key | 行为 |
| --- | --- | --- |
| 搜索 + 版本 / 加载器 / 排序 | `search` | `downloads:addon-search` → `GET /search`，facets 为 `project_type` + `versions` + `categories`；打开页签时用空关键词先拉热门 |
| 结果卡片 · 图标 | 运行时 | 项目自己的图标：`<img src="mcdl-media://addon-icon/<encodeURIComponent(cdn 地址)>">`，由主进程抓取并缓存，失败才回落成首字母 |
| 结果卡片 · 正文 | 运行时 | 标题、作者、下载量、两行简介；点击打开「内容下载页」 |
| 内容下载页 · 版本行 | 运行时 | `downloads:addon-versions` 按当前实例的 MC 版本 / 加载器过滤；没有匹配时回退成全部版本并提示 |
| 内容下载页 · 必需前置 | — | 勾选时递归下载 `dependency_type=required` 的文件（深度 3、最多 8 个） |
| 内容下载页 · 确定 | `button.ok` | `downloads:install-addon` → 下载到实例的内容目录（`mods` / `resourcepacks` / `shaderpacks`，按版本隔离规则解析） |
| 内容下载页 · 下载到本地文件夹 | `mods.save_as` | 选目录后只下载，不写入实例 |
| 内容下载页 · 取消 | `button.cancel` | 关闭弹窗（下载中禁止关闭） |

目标实例取右侧控制台当前选中的实例；没选实例时「确定」禁用并提示。文件下载走主进程的
`fetch` + 流式写盘，先写 `.part`、校验 SHA1 后改名，重名自动加 `(2)`。世界页签没有在线源：
Modrinth 没有世界分类，CurseForge 需要 API Key。

**内容图标**：搜索结果里的图标是 Modrinth 项目自己上传的图（`icon_url`）。渲染层 CSP 只有
`img-src 'self' data: mcdl-media:`，页面也不联网，所以图标不直连 CDN，而是由主进程的
`modrinth.fetchProjectIcon()` 抓取（只放行 `cdn.modrinth.com`、MIME 白名单、≤2 MB、重定向后
再校验 host），再经 `mcdl-media://addon-icon/<encodeURIComponent(icon_url)>` 交给 `<img>`。
主进程按 URL 做 240 条 LRU 内存缓存，翻页 / 切页签 / 重新搜索不重复下载；抓取失败或不是
CDN 地址时，卡片回落成项目名首字母。

### 设置页（对照 [L2] 设置：6 个页签）

`stageSettings` 右侧是 6 个页签：游戏设置 / Java 管理 / 通用 / 外观 / 下载 / 关于。页签状态记在
`renderer.js` 的 `setSettingsTab()`，其余面板保持 `hidden`。所有设置项写 `launcher-settings.json`：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `memoryMb` / `width` / `height` / `jvmArgs` / `javaPath` | — | 启动参数（原有字段，实例级可覆盖） |
| `gameIsolation` | `auto` | 默认版本隔离策略：`auto`（按目录判断）/ `isolated` / `global`；`instance-store` 的 `contentRootFor()` 直接使用 |
| `disableAprilFools` | `false` | 记录用；当前版本没有愚人节彩蛋 |
| `language` | `zh-CN` | 目前只提供简体中文 |
| `versionListSource` | `auto` | 版本列表的 `--source`：`auto` / `official` / `bmclapi` |
| `downloadSource` | `auto` | 安装原版 / 加载器时的 `--source` |
| `addonSource` | `modrinth` | 附加内容默认源；CurseForge 需要 API Key，选项禁用 |
| `disableAnimations` | `false` | 给 `body` 加 `no-motion`，停掉过渡、极光层与壁纸视频 |
| `wallMode` | `default` | 壁纸模式：`default` 原样 / `custom` 启用自上传壁纸 |
| `wallMedia` | `image` | `image` / `video`，由「上传图片 / 上传视频」写入，渲染层不能单独改 |
| `wallFile` | `''` | 图片 = `backgrounds/` 内的裸文件名；视频 = 本机绝对路径 |
| `wallPolicy` | `single` | `single` 固定 / `startup` 每次启动随机一次 / `random` 每次重建随机 |
| `wallBlur` | `18` | 框外模糊 0–40px |
| `wallDim` | `30` | 框外暗化 0–70%，框内另叠 `0.12 + 0.6×` |
| `wallInnerFit` | `contain` | 框内 contain / cover；画中画关闭时该控件禁用 |
| `wallPip` | `true` | 画中画：`true` 内外双图，`false` 内外同一张 cover |
| `presets` | `[]` | 游戏设置预设：`{ id, name, memoryMb?, width?, height?, jvmArgs?, gameIsolation? }`，最多 50 个 |

- 游戏设置页签保留表单 + 「保存设置」；其余页签的控件改完立即 `saveSettings`（`saveSettingsPatch()`）。
- **预设**：`#settingsPreset` 下拉 + `新建预设 / 应用 / 删除`。新建时把当前表单值存进 `presets`；
  应用会把预设写回表单并直接保存；主进程 `normalizePresets()` 做长度 / 数值范围 / 枚举校验。
- 下载源三项会分别进入 `mcdl --list`、`--install`、`--install-loader`、`--list-loaders`。
- Java 管理页签列出 `settings:get` 扫描到的运行时，可指定固定 Java 或「重新扫描」；「选择 Java…」
  走系统对话框并登记指纹；「安装 Java」先弹 `dlgJavaDownload`（8 / 17 / 21 / 25），确认后
  `java:install` 从 Adoptium 下载 Temurin JDK 到 `<userData>/java/temurin-<主版本>`，
  解压后 `registerJava()` 登记并保存为 `javaPath`。装过的同主版本会直接复用，不重复下载。
- 关于页签通过 `app:info` 显示版本、Electron / Chromium / Node、平台与数据目录，并提供项目主页 /
  开源许可两个外链；用户协议入口未单独提供。
- 通用页签新增 **NBT 编辑器**入口：`nbt:pick` 选文件并拿一次性 token，`dlgNbt` 里以
  「路径 / 类型 / 值」表格编辑标量字段，保存时 `nbt:save` 按路径写回（先备份 `.bak`）。
  只做字段编辑，不新增 / 删除节点。入口未实现的部分（主题）继续保留禁用占位。

外观页签按 `docs/history/ui-tree-controls.html` 的 [L3] 个性化分层：**主题**（主题 / 主题模式 /
色彩模式 / 抗锯齿 / 导出当前主题 / 主题包管理）与**窗口**（标题栏透明 / 窗口透明）这一轮不做，
但都按 `LineSelect` / `LineToggle` / `LineButton` 的真实控件先占位（`is-disabled` + 原生 `disabled`），
下一层接上时只换数据源，不动结构。**背景**一组是已实现的部分，见下节。

### 自上传壁纸（清单外新增）

清单里的 `launcher.background.load_policy`（背景加载方式）落在 `wallPolicy` 上，其余 7 个键是新增的。

- **图层**：`#wallLayer` 插在 `.stage` 内、`.frame` 之前（`.stage` 有 `isolation:isolate`，
  放到外面且 z-index ≥ 2 会盖住整个内容区）。`#wallOuter` 全屏 `cover` + `blur(var(--wall-blur))`
  + 暗化伪元素；`#wallInner` 用 `--frame-x/y/w/h` 对齐边框内侧，`contain` + 同图虚化补边；
  `.frame` 的 z-index 从 1 提到 2，靠 DOM 顺序压住内层壁纸，保证 1px 边框与四角可见。
- **可读性**：`#wallInner` 里叠了一层跟随 `wallDim` 的暗化 + `#bg` 原有的暗角与网格；
  壁纸开启时 `body.has-wallpaper` 会给 `.settings-block` 补半透明底、给无底板的大字补投影。
- **画中画关闭**：内层媒体铺成 `100vw × 100vh` 再用负偏移对齐，内外是同一张连续的 cover 图；
  在小盒子里直接 `object-fit:cover` 会以盒子为中心重新裁切，边框处出现接缝。
- **视频**：内外各一个 `<video>`（`muted loop playsinline preload=auto`），内层为主时钟，
  每 500ms 检查漂移、超过 0.3s 就把外层 seek 过去；切后台双暂停；软渲染 / 关动画时降为静态首帧
  并隐藏外壳（`is-lite`）。1080p 双解码大约多占 60–120 MB 显存。
- **文件**：`<userData>/backgrounds/` 存图片（`<sha1 前 12 位>-<原名>.<ext>`）与 `.thumbs/` 里的
  160px 缩略图；视频只记绝对路径、**不复制也不删除**。删除当前壁纸会把 `wallMode` 一并回落到
  `default`。
- **协议**：`mcdl-media://bg/<name>` 服务图片、`mcdl-media://thumb/<name>` 服务缩略图、
  `mcdl-media://ext/<base64url>` 服务**当前那一支**视频；响应支持 `Range`（206 + `Content-Range`），
  否则 `<video>` 拖进度会先读完整段。登记在 `app.whenReady()` 之前，特权为
  `{ standard: true, stream: true }`，CSP 里放行 `img-src` / `media-src`。

### 世界管理（对照 [L4] 世界管理 与 [L4] 世界详情）

实例详情的「世界」页签是独立实现，不再走通用内容列表：

- **世界列表**：读 `<saves>/<世界>/level.dat`，显示世界名、版本、游戏模式、难度、大小、最后游玩时间和
  `icon.png`；支持搜索、刷新、打开世界文件夹；每行「管理」进入世界管理，`⋯` 打开快捷菜单
  （启动游戏 / 世界文件夹 / 导出 / 复制 / 删除）。
- **世界管理**：3 个页签，与清单一致：
  - `世界信息`：允许命令、生成建筑、难度、锁定难度、游戏模式 5 项，全部直接读写 `level.dat`
    （覆盖前把原文件复制成 `level.dat_old`）；另有启动游戏、生成启动脚本、导出、复制、删除、
    世界文件夹与 Chunkbase 地图（种子 / 要塞 / 下界要塞 / 末地城，带 `Data.RandomSeed`）。
  - `备份管理`：把世界目录打成 zip 存到 `<userData>/world-backups/<saves 哈希>/`，可恢复 / 删除；
    恢复会解压成「世界名 (恢复 时间)」，不覆盖原世界。
  - `数据包管理`：列出世界 `datapacks/` 下的文件与文件夹，支持导入 zip / 删除 / 打开文件夹。
- NBT 读写由 `electron/nbt.js` 完成：完整解析 12 种 tag（含 Long / IntArray / LongArray），
  读出整棵树、改几个字段再原样写回，未知字段不会丢；写入用 gzip。
- zip 不引入依赖：导出 / 备份用 Windows 自带的 `tar.exe`（bsdtar）`-a -c -f` 打包。

### 启动进度窗口 / 实例文件不完整 / 恢复模式（对照 [L5] 全局弹窗）

- **启动进度窗口**（`dlgLaunchProgress`，入口：任意一次启动）：每收到一个 `stage` 事件就
  追加 / 更新一行，只有「正在做」的那一行下面有动画进度条（软件渲染下退化成静态条）。
  行内容 = 步骤名（`STAGE_LABELS`）+ 引擎给的真实 `detail`。
  **关闭时机 = 游戏窗口真的出现**（`stage: window` + `done`），不是 spawn：
  spawn 之后界面继续显示「等待游戏窗口出现」，并把「取消」换成「停止游戏」。
  失败时停在失败那一步，`取消` 换成 `关闭`。`取消` → `launcher:stop`，规划阶段不会 spawn。
  设计约束：**不允许出现代码里没做的步骤**（所以没有「下载整合包」这类占位行）。
- **实例文件不完整**（`dlgPreflight`）：闸门失败时由 `preflight-failed` 事件打开，
  逐条列 `缺失 / 文件是空的 / 大小不符 / 校验和不符`，按钮「修复缺失文件」→ `launcher:repair`，
  修好后同一按钮变成「重新启动」。
- **崩溃恢复页**（`renderer/recovery.html`，不是 dialog）：渲染进程崩溃 3 次/分钟或主文档
  加载失败时由主进程 `loadFile` 切过去。零依赖静态页，三个出口
  `recovery:reload` / `recovery:reset-workspace` / `recovery:export-diagnostics`。

### 日志窗口 / 崩溃窗口 / 游戏崩溃窗口（对照 [L5] 全局弹窗）

三个窗口共用 `dlgLog` / `dlgCrash` / `dlgGameCrash`，都不阻塞游戏进程。

- **日志窗口**（`dlgLog`，入口：「测试游戏」启动后、「管理 → 查看日志」、「游戏崩溃窗口 → 日志」）：
  - 打开时 `logs:tail` 读一次快照（优先本次启动的日志，没有就取该游戏目录下最新的
    `mcdl-launcher-*.log`），之后把 `launcher:launch-progress` 的 `output` 事件续写进 `<pre>`；
  - `自动滚动` 是 `role="switch"` 的开关，关掉后新行继续追加但不再滚到底；
  - `导出` → `logs:export` 另存并定位；`结束游戏进程` → `launcher:stop`（只有活动进程时可用）；
    `导出游戏运行栈` → `logs:dump` 打开 `dlgDump`（文本块 + 复制）；`清除` 只清空 `<pre>`，不删文件。
- **崩溃窗口**（`dlgCrash`）：主进程 `uncaughtException` / `unhandledRejection` 通过
  `launcher:crash` 推送，渲染进程自身的 `error` / `unhandledrejection` 也会打开它；
  只有一个必需按钮「打开日志文件夹」→ `logs:open-folder?scope=app`。主进程的 `console.*`
  与异常由 `app-log.js` 落盘到 `<userData>/logs/launcher-YYYYMMDD.log`。
- **游戏崩溃窗口**（`dlgGameCrash`）：`exit` 事件里 `code !== 0 && !stopped` 时弹出，
  显示实例 / 版本 / 运行时长 / 日志路径，并补一段日志尾部；3 个强调按钮：
  `导出游戏崩溃信息`（`crash:export`，崩溃报告 + 日志尾部打包）、`日志`（打开日志窗口）、
  `帮助`（外链 `docs/troubleshooting.md`）。手动「结束游戏进程」不会弹这个窗口。

### 导出整合包向导（对照 export/ModpackTypeSelectionPage / ModpackFileSelectionPage / ModpackInfoPage）

实例菜单、实例操作对话框的「导出整合包」都打开同一个 `dlgExport`，3 步：

1. **类型**：CurseForge（`manifest.json`）或 Modrinth（`modrinth.index.json`）。
2. **文件**：`modpack:scan` 扫出的 7 类内容（模组 / 配置 / 资源包 / 光影 / 存档 / 投影 / 游戏选项），
   默认勾选模组、配置、资源包、光影、选项；显示每类文件数与体积。
3. **信息**：名称 / 版本 / 作者 / 简介、认证服务器、4 个开关（强制升级 / 包含启动器 /
   不匹配远程文件 / 不匹配 CurseForge 远程资源），点「导出」选保存位置。

实现要点（`electron/modpack-export.js`）：

- 选中文件先复制到临时目录的 `overrides/`（实例目录优先于全局目录，同一相对路径去重），
  写清单后再用 `tar.exe -a -c` 压缩；整个过程在 `<目标目录>/.mcdl-export-*` 里完成，失败只删临时文件。
- **不生成远程 `files` 列表**：本地文件没有 CurseForge project/file id，Modrinth 也需要先查版本，
  写进去反而会让别的启动器装不上；「不匹配远程文件」关掉时才为文件计算 SHA-1 / SHA-512 供排查。
- 「包含启动器」写入 `launcher/README.txt`（启动器本体是 Electron 应用，不随整合包分发）。
- 清单里多一个 `mcdl` 块记录导出参数；Minecraft 版本优先从版本 JSON 的 `inheritsFrom` / `id` 反推，
  避免外部实例用中文文件夹名当版本号。

### 账户页（对照 `docs/history/ui-tree-controls.html` 的 [L2] 账户）


布局：左侧是巨大的「账户」标题与说明，右侧是两块内容（整块靠右，最大 640px）——
上面三张并列的操作卡片，下面已保存账户的头像卡片。卡片都是半透明底 + `backdrop-filter`
毛玻璃 + 极细亮边，悬浮时上浮 5px 并叠一层微光。

| 控件 | control key | 行为 |
| --- | --- | --- |
| 微软账户（卡片） | `account.methods.microsoft` | 打开「微软登录」弹窗 |
| 离线模式（卡片） | `account.methods.offline` | 打开「添加账户」弹窗的离线页签 |
| 添加认证服务器（卡片） | `account.injector.add` | 打开「添加认证服务器」向导 |
| 已保存账户（头像卡片） | 运行时 | 点击卡片切换账号；`⋯` 打开账户菜单 |

头像卡片：正方形头像 + 玩家名 + 类型说明。有皮肤的账号直接取皮肤 PNG 的头部 8×8 区域；
没有皮肤时用名字哈希生成的 8×8 对称像素头像（色相固定在蓝—青区间）。当前账号的卡片
带发光边框，并在头像右下角显示一个绿点。

账户菜单：设为当前账户（未选中时）、离线皮肤设置（离线账号）、刷新皮肤与重新登录（微软 / 第三方）、删除账户。

五个 [L5] 弹窗：

| 弹窗 | 控件 | 说明 |
| --- | --- | --- |
| 微软登录 | 取消 / 登录 + 可点击帮助面板 | 登录成功后自动关闭并选中；帮助面板用 `shell:open-external` 打开账号安全页（只允许 http(s)） |
| 添加账户 | 取消 / 登录 · 取消 / 确定 | 「离线模式」「正版登录」两个页签切换页脚按钮 |
| 添加账户 · 离线页 | 可点击皮肤预览 + 选择皮肤 + 取消选择 + 模型（选中皮肤后才出现） | 建账号时顺手选皮肤；模型分「经典 · 4px 手臂」「纤细 · 3px 手臂」；点「登录」后先建账号再 `accounts:set-skin`，皮肤失败不影响账号 |
| 添加认证服务器 | 取消 / 下一步 / 上一步 / 完成 | 第一步验证地址，第二步展示服务器信息 |
| 离线皮肤设置 | 清除皮肤 · 取消 / 确定 | 选择 PNG 后预览、切换模型 |
| 确认删除 | 取消 / 删除 | 删除账号前确认 |

标题栏的 `-webkit-app-region: drag` 覆盖整条顶栏，窗口控制按钮位于 `no-drag` 区域；
双击空白处切换最大化。

侧边栏五项中，「账户」「实例列表」「下载」「设置」有对应面板；「游戏」回到主视区。下载中心从原
「待接入并禁用」改为独立二级页面（见上文「下载中心」）。

## 渲染层约定

- `window.launcherAPI` 是唯一可用的桥接对象，`ipcRenderer` 不暴露。
- 主视区状态通过 `.main-stage` 上的类切换：`is-create`（实例管理）、`is-account`、`is-settings`；
  面板切换会派发 `launcher:panel-change`。
- 其他自定义事件：`launcher:navigate`、`launcher:instance-selected`、`launcher:instance-created`、
  `launcher:instance-action`。
- 侧边栏项由 `data-nav` 标识，事件处理器集中在 `renderer.js` 末尾的委托监听中。

## 外部网络请求

- 启动器主动访问的外部服务只有两类：账号相关的微软 / Mojang 接口，以及 Modrinth 内容接口
  （`electron/modrinth.js`）。
- 所有请求都在主进程发出，渲染进程不直连；统一带 `User-Agent: mcdl-launcher/<版本>`，并有 20 秒超时。
- 内容文件先写 `.part`，校验 SHA1 后再改名落盘；校验失败删除临时文件。
- 下载请求不带账号令牌，令牌只在启动游戏与账号刷新时使用。

## 安全边界

- 外部链接一律交给 `shell.openExternal`，窗口内导航与子框架导航都被拦截；
  `session` 的网页权限请求（摄像头 / 通知 / 剪贴板读取…）一律拒绝。
- `index.html` 带 CSP：`script-src 'self'`，无 `unsafe-inline` / `unsafe-eval`，`connect-src 'none'`
  （渲染进程本来就不发网络请求，这条把"XSS 之后外传数据"也掐掉）。
- 主进程与渲染进程之间只传纯数据，不传函数或对象引用。
- 账号令牌只写本地文件，不进入渲染进程，也不随日志输出；**生成的启动脚本里也不含令牌**
  （写占位符，运行时由脚本从 `accounts.json` 读一次）。
- **路径输入一律过 `electron/path-guard.js`**：拒绝 UNC / 设备路径（`\\server\share`、`\\?\C:\`），
  必须是绝对路径，越界判断用 `path.relative`。`openFolderPath` / `revealPath` 在做任何 `fs.*` 之前就校验，
  因为 `fs.stat` 本身就会对 UNC 路径外发认证。
- **可执行文件只能来自 `electron/launch-spec.js`**：文件名必须是 `java`/`javaw`，参数必须是字符串数组，
  产出物冻结后才交给 `spawn`（`launchInstance` 不再自己拼 `spawn` 参数）。
- **javaPath 走授权表**（`java-runtime.js`）：登记时记录 `{ real, size, mtimeMs, major }` 指纹，
  启动时只比对指纹、不执行；唯一会执行"尚未授权"二进制的时刻是「设置 → Java → 选择 Java…」
  对话框，以及启动器自己枚举到的 Java。文件指纹一变，授权作废并要求重选，**不再静默回退自动探测**。
  校验放在 `createLaunchSpec` 的使用点上，新增调用方也绕不过。
- **整合包只认一次性 token**：`pick-pack`（对话框）和 `prepare-pack`（拖拽）走同一条预检管线
  （条目 / 大小 / 压缩比 / 链接条目 / `..` / ADS / 保留名），通过后发 10 分钟有效、用后即失效的 token；
  `install-pack` 只认 token，并在解压后用 `verifyExtractedTree` 核对结果（出现链接或越界即整包删除）。
- **脚本类产物只允许"模板 + 数据"**：`electron/launch-script.js` 生成固定的 `.ps1`，
  实例名 / 参数 / Java 路径都放在同目录的 `launch-data.json` 里。
  不要把任何用户可控字符串拼进 `.ps1` / `.bat` / `.sh` 的正文。
- IPC handler 的调用方校验（`assertAppWindow`）除了比对 webContents，还要求
  `event.senderFrame === mainWindow.webContents.mainFrame` 且来源是 `file://`；
  这样将来引入 iframe / webview 时，子框架也调不到这些特权通道。
- **壁纸只能从对话框来**：`mcdl-media://` 的 `bg` / `thumb` 通道只接受 `backgrounds/` 内的裸文件名
  （`path.basename` 相等 + realpath 越界判定），`ext` 通道只服务"当前 `settings.wallFile`"那一个路径。
  对应地，`settings:save` 禁止渲染进程把 `wallFile` 改成 `backgrounds/` 之外的值——否则这条协议就是
  "按扩展名读任意本地文件"的通道。上传时还会核对文件头（改名的 exe 过不了）。
- **NBT 编辑器只认 token**：`nbt:pick` 由主进程弹对话框选文件，返回一次性 token；`nbt:save` 只接受 token，
  渲染层无法指定任意路径写回。写入前复制 `.bak`，类型 / 范围不合法直接拒绝。
- **崩溃信息导出只读固定目录**：`crash:export` 的 `crashReport` / `logFile` 必须分别位于该实例游戏目录的
  `crash-reports/` 与 `logs/` 内（`pathGuard.assertInsideReal`），避免变成"读任意本地文本"的通道。
- **导出整合包只读实例内容**：`modpack:scan` / `modpack:export` 的实例由 `requireInstance()` 解析，
  写入目标由系统保存对话框决定；打包先写同目录临时文件，失败只删临时文件，不会误删用户已有的 zip。
- **更新整合包不认渲染层拼的路径**：`instances:merge-pack` 只用「同一 gameDir + versions 下文件夹名」
  定位临时实例，两边目录都必须在 `versions/` 下；`downloads:install-pack` 的 `gameDir` 必须是已登记的
  游戏目录（`assertGameDirAllowed`）。
- **Java 安装**：从 `https://api.adoptium.net` 下载到启动器数据目录，解压后由主进程 `registerJava()`
  登记授权；不改系统 PATH / JAVA_HOME，也不静默覆盖用户已选的 Java。
- 启动入口不要加 `--no-sandbox`：它会关掉整个 Chromium 进程沙箱，`webPreferences.sandbox` 随之失效。
  排查问题请用 `npm run start:troubleshoot`。

回归检查（三份脚本，各管一层）：

```powershell
node docs/security/audit.js            # 静态边界（命中高危退出码 1，可接 CI）
node docs/security/poc.js              # 攻击模拟：每条发现一个断言
node docs/security/runtime-check.js    # 运行时：真的启动一次，验证 IPC 与 CSP 生效
node docs/security/wallpaper-check.js  # 壁纸：协议 / 图层 / 视频同步 / 删除与降级
```

细节与历史见 [security-audit.md](security-audit.md)。

## 开发与调试

```powershell
.\run-electron.ps1 -Dev        # 打开 DevTools
cd electron; npm.cmd run dev   # 等价（需先安装依赖）
```

日志：

- 主进程 `console.log` 同时输出到启动终端与 `<userData>/logs/launcher-YYYYMMDD.log`
  （`app-log.js` 包了一层 console；崩溃窗口的「打开日志文件夹」指向这里）；
- 渲染进程错误见 DevTools Console，未捕获的 `error` / `unhandledrejection` 会弹出崩溃窗口；
- 游戏输出见 `<gameDir>/logs/mcdl-launcher-<时间戳>.log` 与 `latest.log`，可用标题栏「帮助」打开日志窗口查看。

`docs/history/` 下的 `ui-*.md` / `ui-*.html` 是重写前 HMCL 界面的控件清单，仅作设计参考，运行时不使用。

## 后续方向

- 下载中心的「世界」页签：Modrinth 没有世界分类，CurseForge 需要 API Key；目前只能在世界管理里导入本地存档。
- 内容下载的依赖解析只处理 `required` 且深度 3 以内，嵌套可选依赖与版本锁定策略还没做。
- 整合包来源：Modrinth / CurseForge 在线浏览与一键安装（`mcdl --install-pack` 已支持本地文件）。
- 新闻区：主视区的更新日志仍是占位内容。
- 离线皮肤注入游戏：目前只保存与预览，需要自定义皮肤服务或 CustomSkinLoader。
- 导出整合包（`modpack.export`）：向导已接入（CurseForge / Modrinth 两种格式）；后续可补
  「按 Modrinth / CurseForge 文件 ID 生成远程 files 列表」，让整合包更小。
- 模组「检查更新」：按钮已占位并禁用，需要模组来源（Modrinth / CurseForge）与版本比对。
- 资源包启用 / 禁用：要读写 `options.txt` 的 `resourcePacks`，未做。
- 世界的「进入世界」直启（`--quickPlaySingleplayer`）、数据包启用 / 禁用（`level.dat` 的 DataPacks）
  与新建世界未做。
- 设置页的外观页签：背景（自上传壁纸）已接入；主题 / 主题模式 / 色彩模式 / 标题栏透明 /
  窗口透明 / 抗锯齿 / 主题包管理仍是 `disabled` 占位，等主题引擎一起做。
- 更新整合包目前是「装到临时实例 → 覆盖合并」，后续可做逐文件差异更新（保留用户改动过的配置）。
- 内容更新（`instance.update`）与「检查更新」的版本比对仍未做。
- 日志窗口是「文件尾部 + 实时事件」；后续可加过滤 / 关键字搜索 / 按级别着色。
- Java 扫描首次约 15 秒（`mcdl --list-java` + 逐个探测）；已有 24 小时磁盘缓存，可再做后台预热。
