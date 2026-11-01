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
├── renderer/
│   ├── index.html        # 界面与样式（单文件内联 CSS）
│   └── renderer.js       # 渲染逻辑：主视区、实例面板、账户面板 + 弹窗、设置面板
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
| 探测其他启动器目录 | `--list-dirs` |
| 探测本机 Java | `--list-java` |

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
| `%APPDATA%\mcdl-launcher-electron\scanned-game-dirs.json` | 主动扫描过的其他启动器目录 |
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
| `instances:create` | renderer → main | 调用 `mcdl --install` 安装原版 |
| `instances:install-progress` | main → renderer | 安装输出 / 进度 |
| `instances:rename` | renderer → main | 重命名实例别名（写 `instance-display-names.json`） |
| `instances:duplicate` | renderer → main | 复制实例目录为「… - 副本」 |
| `instances:remove` | renderer → main | 删除 `versions/<id>` 目录（仅限 versions 下） |
| `instances:open-folder` | renderer → main | 在资源管理器中打开实例运行目录 |
| `instances:launch-script` | renderer → main | 生成 `启动-<版本>.ps1/.bat`；实例目录不可写时落到数据目录 |
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
| `settings:get` / `settings:save` | renderer → main | 读取 / 保存启动设置 |
| `shell:open-logs` | renderer → main | 打开应用日志目录 |

主进程用 `assertAppWindow()` 校验调用方是否为当前应用窗口，其他来源的调用一律拒绝。

## 界面结构

```text
窗口（frame: false）
├── 标题栏  左：返回 / 刷新 / 关闭当前页 / 帮助（打开日志目录）
│           右：最小化 / 最大化 / 关闭
├── 侧边栏  账户 / 游戏 / 实例列表 / 下载中心（待接入，禁用） / 设置
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
| 实例行 | 运行时 | 单击选中；双击启动；`⋯` 或右键打开实例菜单 |

实例右键菜单 7 项（清单里归在共享分支的 `GameListCell`）：

| 菜单项 | 行为 |
| --- | --- |
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

侧边栏五项中，「账户」「实例列表」「设置」有对应面板；「下载中心」标为待接入并禁用；
「游戏」回到主视区。

## 渲染层约定

- `window.launcherAPI` 是唯一可用的桥接对象，`ipcRenderer` 不暴露。
- 主视区状态通过 `.main-stage` 上的类切换：`is-create`（实例管理）、`is-account`、`is-settings`；
  面板切换会派发 `launcher:panel-change`。
- 其他自定义事件：`launcher:navigate`、`launcher:instance-selected`、`launcher:instance-created`、
  `launcher:instance-action`。
- 侧边栏项由 `data-nav` 标识，事件处理器集中在 `renderer.js` 末尾的委托监听中。

## 安全边界

- 外部链接一律交给 `shell.openExternal`，窗口内导航被拦截。
- 主进程与渲染进程之间只传纯数据，不传函数或对象引用。
- 账号令牌只写本地文件，不进入渲染进程，也不随日志输出。

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

- 模组加载器安装（Fabric / NeoForge / Forge / Quilt）：目前下拉项禁用，`mcdl` 只处理原版文件。
- 下载中心面板与新闻区：目前为占位（下载入口与「前往下载页面」已标为待接入并禁用）。
- 实例级设置（单独的内存、JVM 参数、Java 版本），当前设置是全局的。
- 离线皮肤注入游戏：目前只保存与预览，需要自定义皮肤服务或 CustomSkinLoader。
- 导出整合包（`modpack.export`）：实例菜单里已放出入口但禁用，需要整理 `mods/config/saves` 的打包逻辑。
- Java 扫描首次约 15 秒（`mcdl --list-java` + 逐个探测）；已有 24 小时磁盘缓存，可再做后台预热。
