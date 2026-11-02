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
├── mcdl-service.js       # 调用 mcdl/mcdl.jar：目录探测、实例扫描、版本列表、安装
├── java-runtime.js       # 本机 Java 探测与版本挑选
├── version-manifest.js   # 版本 JSON 解析：inheritsFrom / rules / classpath / natives
├── launch.js             # 真实启动：命令拼接、natives 解压、进程拉起
├── accounts.js           # 离线 / 微软 / authlib-injector 账号、认证服务器、离线皮肤
├── game-directories.js   # 用户添加的游戏文件夹
├── instance-store.js     # 实例级设置 / 图标 / 内容目录与内容管理
├── modrinth.js           # Modrinth 客户端：搜索、版本、必需前置、流式下载
├── nbt.js                # 最小 NBT 读写（level.dat，全部 12 种 tag + gzip）
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
6. 主进程用 `javaw.exe` 拉起进程，stdout/stderr 写入
   `<gameDir>/logs/mcdl-launcher-<时间戳>.log`，并通过 `launcher:launch-progress` 推送阶段：
   `starting` → `spawned` → `output` → `exit`（失败为 `error`）。

实例查找统一走 `rescanInstances()`（启动器目录 + 用户添加的游戏文件夹 + 已缓存的其他启动器），
所以从「添加游戏文件夹」加进来的实例也能直接启动 / 生成脚本。

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
| `launcher:stop` | renderer → main | 结束正在运行的游戏进程 |
| `launcher:active` | renderer → main | 列出运行中的游戏进程 |
| `launcher:launch-progress` | main → renderer | 启动阶段与游戏输出 |
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
| `settings:get` / `settings:save` | renderer → main | 读取 / 保存启动设置（含下载源、隔离策略、动画开关） |
| `settings:preferences` | renderer → main | 启动时只读偏好，不触发 Java 扫描（用于恢复「关闭动画」） |
| `app:info` | renderer → main | 关于页：版本 / Electron / Node / 平台 / 数据目录 / 仓库地址 |
| `worlds:list` / `worlds:info` | renderer → main | 世界列表（读 level.dat）/ 单个世界信息 |
| `worlds:save-info` | renderer → main | 写入 level.dat（作弊 / 生成建筑 / 难度 / 锁定 / 模式） |
| `worlds:delete` / `worlds:duplicate` | renderer → main | 删除 / 复制世界目录 |
| `worlds:export` | renderer → main | 选保存路径后把世界目录打包成 zip |
| `worlds:open-folder` | renderer → main | 打开世界目录 |
| `worlds:backups` / `backup-create` / `backup-restore` / `backup-delete` | renderer → main | 世界备份的列表 / 创建 / 恢复 / 删除 |
| `worlds:open-backup-folder` | renderer → main | 打开该存档目录的备份文件夹 |
| `worlds:datapacks` / `import-datapack` / `delete-datapack` | renderer → main | 数据包列表 / 导入 / 删除 |
| `shell:open-logs` | renderer → main | 打开应用日志目录 |

主进程用 `assertAppWindow()` 校验调用方是否为当前应用窗口，其他来源的调用一律拒绝。

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

### 实例详情（对照 [L3] 实例详情：6 页签）

入口三个：实例列表右键菜单「实例详情」、右侧「当前配置」卡、实例操作弹窗里的入口。

| 页签 | key | 内容 |
| --- | --- | --- |
| 游戏设置 | `settings.game` | 实例级内存 / Java / 窗口宽高 / 额外 JVM 参数；留空 = 继承全局，占位符显示全局值 |
| 自动安装 | `settings.tabs.installers` | Forge / NeoForge / Fabric / Quilt 可安装（`loaders:list` + `instances:create`，实例目录为当前实例所在目录）；LiteLoader / OptiFine 仍为禁用占位 |
| 模组管理 | `mods.manage` | 搜索、分页（每页 80 + 显示更多）、全选 / 多选、批量启用 / 批量禁用 / 批量删除、定位文件（资源管理器选中）、导入、刷新、打开文件夹；「检查更新」为禁用占位 |
| 资源包 | `resourcepack.manage` | 搜索、分页、多选、批量删除、定位文件、导入、刷新、打开文件夹（启用状态需改 `options.txt`，未接入） |
| 世界 | `world.manage` | 世界列表（图标 / 版本 / 模式 / 难度 / 大小 / 时间）＋管理页：世界信息（读写 level.dat）、备份管理、数据包管理 |
| 原理图 | `schematics.manage` | 搜索、分页、多选、批量删除、定位文件、导入（schematic / schem / nbt / litematic）、刷新 |

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
| 结果卡片 | 运行时 | 图标、标题、作者、下载量、两行简介；点击打开「内容下载页」 |
| 内容下载页 · 版本行 | 运行时 | `downloads:addon-versions` 按当前实例的 MC 版本 / 加载器过滤；没有匹配时回退成全部版本并提示 |
| 内容下载页 · 必需前置 | — | 勾选时递归下载 `dependency_type=required` 的文件（深度 3、最多 8 个） |
| 内容下载页 · 确定 | `button.ok` | `downloads:install-addon` → 下载到实例的内容目录（`mods` / `resourcepacks` / `shaderpacks`，按版本隔离规则解析） |
| 内容下载页 · 下载到本地文件夹 | `mods.save_as` | 选目录后只下载，不写入实例 |
| 内容下载页 · 取消 | `button.cancel` | 关闭弹窗（下载中禁止关闭） |

目标实例取右侧控制台当前选中的实例；没选实例时「确定」禁用并提示。文件下载走主进程的
`fetch` + 流式写盘，先写 `.part`、校验 SHA1 后改名，重名自动加 `(2)`。世界页签没有在线源：
Modrinth 没有世界分类，CurseForge 需要 API Key。

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
| `disableAnimations` | `false` | 给 `body` 加 `no-motion`，停掉过渡与极光层动画 |

- 游戏设置页签保留表单 + 「保存设置」；其余页签的控件改完立即 `saveSettings`（`saveSettingsPatch()`）。
- 下载源三项会分别进入 `mcdl --list`、`--install`、`--install-loader`、`--list-loaders`。
- Java 管理页签列出 `settings:get` 扫描到的运行时，可指定固定 Java 或「重新扫描」；自动安装 / 恢复
  Java 还没接入（按钮禁用并注明）。
- 关于页签通过 `app:info` 显示版本、Electron / Chromium / Node、平台与数据目录，并提供项目主页 /
  开源许可两个外链；用户协议入口未单独提供。

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
- 启动入口不要加 `--no-sandbox`：它会关掉整个 Chromium 进程沙箱，`webPreferences.sandbox` 随之失效。
  排查问题请用 `npm run start:troubleshoot`。

回归检查（三份脚本，各管一层）：

```powershell
node docs/security/audit.js          # 静态边界（命中高危退出码 1，可接 CI）
node docs/security/poc.js            # 攻击模拟：每条发现一个断言
node docs/security/runtime-check.js  # 运行时：真的启动一次，验证 IPC 与 CSP 生效
```

细节与历史见 [security-audit.md](security-audit.md)。

## 开发与调试

```powershell
.\run-electron.ps1 -Dev        # 打开 DevTools
cd electron; npm.cmd run dev   # 等价（需先安装依赖）
```

日志：

- 主进程 `console.log` 输出到启动终端（窗口创建、IPC 注册、启动阶段）；
- 渲染进程错误见 DevTools Console；
- 游戏输出见 `<gameDir>/logs/mcdl-launcher-<时间戳>.log` 与 `latest.log`。

`docs/history/` 下的 `ui-*.md` / `ui-*.html` 是重写前 HMCL 界面的控件清单，仅作设计参考，运行时不使用。

## 后续方向

- 下载中心的「世界」页签：Modrinth 没有世界分类，CurseForge 需要 API Key；目前只能在世界管理里导入本地存档。
- 内容下载的依赖解析只处理 `required` 且深度 3 以内，嵌套可选依赖与版本锁定策略还没做。
- 整合包来源：Modrinth / CurseForge 在线浏览与一键安装（`mcdl --install-pack` 已支持本地文件）。
- 新闻区：主视区的更新日志仍是占位内容。
- 离线皮肤注入游戏：目前只保存与预览，需要自定义皮肤服务或 CustomSkinLoader。
- 导出整合包（`modpack.export`）：实例菜单里已放出入口但禁用，需要整理 `mods/config/saves` 的打包逻辑。
- 模组「检查更新」：按钮已占位并禁用，需要模组来源（Modrinth / CurseForge）与版本比对。
- 资源包启用 / 禁用：要读写 `options.txt` 的 `resourcePacks`，未做。
- 世界的「进入世界」直启（`--quickPlaySingleplayer`）、数据包启用 / 禁用（`level.dat` 的 DataPacks）
  与新建世界未做。
- 设置页的外观页签：主题包 / 主题模式 / 色彩模式 / 背景 / 标题栏透明 / 窗口透明 / 抗锯齿仍未接入，
  目前只有「关闭动画」与深色一套外观。
- Java 管理的自动安装 / 恢复 Java 未接入，需要 Adoptium 之类的下载与运行时注册流程。
- 设置页的「预设」「版本隔离（按实例覆盖）」仍未做。
- 内容更新（`instance.update`）与清理项（`instance.manage.remove_assets` / `clean` 等）：未做。
- Java 扫描首次约 15 秒（`mcdl --list-java` + 逐个探测）；已有 24 小时磁盘缓存，可再做后台预热。
