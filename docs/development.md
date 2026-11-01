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
├── accounts.js           # 离线账号与微软账号
├── renderer/
│   ├── index.html        # 界面与样式（单文件内联 CSS）
│   └── renderer.js       # 渲染逻辑：主视区、实例面板、账户面板、设置面板
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

## 数据文件

| 路径 | 内容 |
| --- | --- |
| `%APPDATA%\MCDL Launcher\.minecraft` | 游戏目录（`versions/`、`libraries/`、`assets/` 等） |
| `%APPDATA%\mcdl-launcher-electron\accounts.json` | 账号与令牌 |
| `%APPDATA%\mcdl-launcher-electron\launcher-settings.json` | 内存 / Java / 窗口尺寸 / 额外 JVM 参数 |
| `%APPDATA%\mcdl-launcher-electron\instance-display-names.json` | 实例别名 |
| `%APPDATA%\mcdl-launcher-electron\scanned-game-dirs.json` | 主动扫描过的其他启动器目录 |
| `%APPDATA%\mcdl-launcher-electron\gpu-crash.json` | 最近一次 GPU 崩溃记录（存在时下次启动走软件渲染） |
| `<gameDir>\logs\mcdl-launcher-<时间戳>.log` | 每次启动的完整输出 |
| `<gameDir>\logs\latest.log` | 游戏自身的日志 |

可用环境变量覆盖默认值：

| 变量 | 作用 |
| --- | --- |
| `MCDL_GAME_DIR` | 游戏目录 |
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
| `instances:list` | renderer → main | 扫描实例（自身目录 + 已缓存的其他启动器） |
| `instances:scan-other` | renderer → main | 主动扫描 PCL / HMCL 并写缓存 |
| `versions:list` | renderer → main | 通过 `mcdl --list` 拉取版本列表 |
| `instances:create` | renderer → main | 调用 `mcdl --install` 安装原版 |
| `instances:install-progress` | main → renderer | 安装输出 / 进度 |
| `launcher:launch` | renderer → main | 构造命令并启动游戏 |
| `launcher:stop` | renderer → main | 结束正在运行的游戏进程 |
| `launcher:active` | renderer → main | 列出运行中的游戏进程 |
| `launcher:launch-progress` | main → renderer | 启动阶段与游戏输出 |
| `accounts:list` | renderer → main | 账号列表（不含令牌） |
| `accounts:add-offline` | renderer → main | 创建并选中离线账号 |
| `accounts:add-microsoft` | renderer → main | 打开登录窗口并完成微软登录 |
| `accounts:select` / `accounts:remove` | renderer → main | 切换 / 删除账号 |
| `settings:get` / `settings:save` | renderer → main | 读取 / 保存启动设置 |
| `shell:open-logs` | renderer → main | 打开应用日志目录 |

主进程用 `assertAppWindow()` 校验调用方是否为当前应用窗口，其他来源的调用一律拒绝。

## 界面结构

```text
窗口（frame: false）
├── 标题栏  左：返回 / 刷新 / 关闭当前页 / 帮助（打开日志目录）
│           右：最小化 / 最大化 / 关闭
├── 侧边栏  账户 / 游戏 / 实例列表 / 下载中心 / 设置
├── 主视区  主视觉（版本名、3D 方块） + 更新日志区
│           └── 二级页面：新建实例、账户、设置
└── 右侧控制台  实例列表 / 当前配置 / 启动按钮
```

标题栏的 `-webkit-app-region: drag` 覆盖整条顶栏，窗口控制按钮位于 `no-drag` 区域；
双击空白处切换最大化。

侧边栏五项中，「账户」「实例列表」「设置」有对应面板；「下载中心」目前只切换高亮；
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
- 下载中心面板与新闻区：目前为占位。
- 实例级设置（单独的内存、JVM 参数、Java 版本），当前设置是全局的。
