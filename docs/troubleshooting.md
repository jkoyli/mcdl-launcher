# 排障

启动器本身的实现细节见 [development.md](development.md)。

## 创建账号 / 保存设置时报 EPERM（无法写入）

```text
无法写入账号文件（EPERM）：C:\Users\<user>\AppData\Roaming\mcdl-launcher-electron\accounts.json
```

说明启动器对该数据目录没有写权限。启动器已经会在启动时探测可写性并自动回退，先看启动终端里的第一行：

```text
[data] userData: <实际使用的目录>
```

| 现象 | 处理 |
| --- | --- |
| 打印的是 `%APPDATA%` 下的路径，但仍报 EPERM | 关闭所有启动器窗口后重试；仍不行就换目录（见下） |
| 打印的是 `%LOCALAPPDATA%` 或程序目录 `data/` | 说明已经回退，账号会写在那里，功能正常 |
| 打印 `no writable data directory` | 所有候选目录都不可写，检查安全软件策略 |

手动指定数据目录：

```powershell
$env:MCDL_USER_DATA = "D:\MCDL\data"
.\run-electron.ps1
```

常见原因：

- 同时开了多个启动器实例，抢同一份数据目录（现版本已强制单实例，需多开可加 `--multi-instance`）；
- 安全软件（企业策略、受控文件夹访问）禁止未签名程序写入 `%APPDATA%`；
- 漫游配置文件/目录重定向异常。

## 启动后没有窗口，直接回到提示符

1. 检查是否有残留进程占用了单实例锁（开发模式下不会触发单实例限制，但崩溃残留仍会留下孤儿进程）：

   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
     Where-Object { $_.CommandLine -like '*mcdl-launcher*' } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
   ```

2. 用带日志的方式启动，观察主进程输出：

   ```powershell
   cd electron
   $env:ELECTRON_ENABLE_LOGGING = "1"
   .\node_modules\electron\dist\electron.exe --no-stdio-init --no-sandbox . --dev
   ```

   正常应依次出现：

   ```text
   [main] booting Electron app (dev=true)
   [main] app ready
   [main] BrowserWindow created
   [main] window ready to show
   [mcdl] jar: ...\mcdl\mcdl.jar
   [mcdl] default game dir: ...\.minecraft
   ```

## Electron 进程直接崩溃（0xC0000005 / 无任何输出）

部分受限会话（远程/沙盒/无交互桌面）里，Electron 创建窗口会以 `0xC0000005` 退出，而
`electron.exe --version` 仍能正常打印版本。这属于运行环境限制，不是应用代码问题，换到普通交互式
桌面会话或另一台 Windows 机器即可。

先排除一个更常见、也可修的原因：**可执行文件所在目录被打上了 Low 完整性标签**，进程被降级后
同样会以 `0xC0000005` 退出。用 `icacls electron.exe` 看一眼有没有
`Mandatory Label\Low Mandatory Level`，有就按「打开文件夹 / 定位文件点了没反应」那一节重置标签。

排查顺序：

```powershell
.\node_modules\electron\dist\electron.exe --version          # 能打印版本 → 二进制本身正常
.\node_modules\electron\dist\electron.exe --no-sandbox --version
```

`启动.bat` 与 `run-electron.ps1` 默认已经带上 `--no-sandbox` 与 `--no-stdio-init`，
可以直接双击启动。

## 点启动后提示「实例文件不完整，已中止启动」

这是**故意**的。以前启动器缺库也照样拉起 Java，游戏侧报 `NoClassDefFoundError` 后秒退，
用户看到的只是「游戏闪退」；现在在拉起进程之前会先校验必需文件：

```text
实例文件不完整，已中止启动（没有拉起 Java）。缺少或不一致 1 项：
依赖库 com.example:core:1.0（libraries\com\example\core\1.0\core-1.0.jar） — 缺失
```

弹窗里会逐条列出「缺什么 + 为什么」（缺失 / 文件是空的 / 大小不符 / 校验和不符），
可以直接点「修复缺失文件」按清单重新下载，修好后按钮变成「重新启动」。

| 情况 | 处理 |
| --- | --- |
| 「修复缺失文件」成功 | 直接点「重新启动」 |
| 提示某些条目「没有下载地址」 | 这些是整合包手工放的文件，需要重新安装该版本 |
| 反复出现校验和不符 | 检查下载源 / 代理，或到实例管理执行「更新游戏资源文件」 |
| 只想先看看缺什么 | 实例管理 →「检查并修复缺失文件」，只检查不会启动游戏 |

校验强度可以在 `<数据目录>/settings.json` 里用 `verifyFiles` 调整：`null`（默认，只哈希客户端 jar /
资源索引 / authlib）、`true`（所有依赖库都算 SHA-1，最保险但启动慢）、`false`（只查存在与非空）。

## 界面白屏 / 崩溃后自动跳到「恢复模式」页

渲染进程崩溃时 Electron 默认没有任何人处理，窗口会静默留白。现在的行为是分层的：

1. 单次崩溃（含 `reason === "oom"`）→ 自动重新加载界面，用户基本无感；
2. 60 秒内连续 3 次 → 判定崩溃循环，切到**零依赖**的恢复页（不加载主界面代码，
   因为主界面本身可能就是崩溃原因）；
3. 主界面 HTML 加载失败（文件被杀软隔离、磁盘错误）也会切到恢复页，而不是白屏。

恢复页有三个出口：

| 按钮 | 作用 |
| --- | --- |
| 重新加载界面 | 重新打开主界面 |
| 重置工作区 | 只清启动器自己的缓存与界面状态（`Cache` / `Local Storage` / `Preferences` 等），**不动**账号、实例、存档、模组 |
| 导出诊断 | 把崩溃记录、GPU 标记、环境信息与日志尾部导出成一个 txt，反馈问题时附上 |

恢复页顶部的「原因」一行会写明是 `crash-loop` 还是 `did-fail-load`，以及崩溃次数和错误码。

## 启动弹窗一直停在「等待游戏窗口出现」

这一步是**故意不提前结束**的：Java 进程起来之后，游戏还要解压资源、初始化 LWJGL、
加载模组，几秒到几分钟才会建出窗口。弹窗一直开着说明启动器还没检测到窗口，
不是卡死；期间状态栏会显示已经等了多久，以及游戏日志的最后一行。

| 情况 | 处理 |
| --- | --- |
| 一直在等，但日志还在滚动 | 正常，大型整合包 + 光影首次加载会慢；点「停止游戏」可以中止 |
| 日志不再更新、CPU 也很低 | 大概率卡死在某个模组，点「停止游戏」，再到实例管理里逐个排查模组 |
| 超过 3 分钟仍没检测到窗口 | 弹窗会显示「180 秒内没有检测到游戏窗口」，这时游戏可能仍在加载；用「日志」看最后一行 |
| 窗口早就出来了，弹窗还不关 | 说明没检测到窗口句柄（极少见，例如游戏把窗口交给别的进程）。点「停止游戏」或直接关掉弹窗，游戏不会受影响 |

## 关于 `--no-stdio-init`
Electron 45 及更早版本在 Windows 上可能因 NUL 设备不可用而在 Node stdio 初始化阶段崩溃，
官方 workaround 是启动时加 `--no-stdio-init`。Electron 46 起内置了 NUL 自动检测并移除了该开关，
升级到 46+ 后应从启动脚本中去掉这个参数。

## PowerShell 拦截 `electron.ps1`

看到「未对文件 electron.ps1 进行数字签名，无法在当前系统上运行该脚本」时，是执行策略拦截了
npm 生成的 `.ps1` shim，与项目无关。三种绕过方式：

```powershell
# 1. 只对当前终端会话放开
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
npm run dev
```

```powershell
# 2. 绕过 shim，直接使用 npm.cmd
npm.cmd run dev
```

```powershell
# 3. 直接调用已下载的 Electron 二进制
.\node_modules\electron\dist\electron.exe .
```

项目自带的 `启动.bat` 与 `run-electron.ps1` 不经过 `.ps1` shim，不会触发该问题。

## 画面卡顿或动画掉帧

界面依赖 `backdrop-filter` 与渐变动画，走 CPU 合成时帧率会明显下降（实测 21–24fps），
硬件加速下可稳定 60fps。先确认当前渲染模式：

```powershell
# 启动终端里应出现
[main] render mode: gpu
```

若显示 `software`，说明硬件加速被关闭或上次 GPU 崩溃留下了记录：

```powershell
# 强制硬件加速（忽略崩溃记录）
$env:MCDL_RENDER = 'gpu'; .\run-electron.ps1
```

```powershell
# 或删除崩溃记录后正常启动
Remove-Item "$env:APPDATA\mcdl-launcher-electron\gpu-crash.json" -ErrorAction SilentlyContinue
```

需要反向强制软件渲染（例如某些远程桌面/虚拟机上 GPU 不可靠）：

```powershell
.\run-electron.ps1 -SoftwareRender
```

软件渲染模式下启动器会自动关闭毛玻璃与极光动画（`body.is-software`），
画面观感会简化，但帧率稳定。

## 启动后几秒明显卡顿

软件渲染下，首屏需要把所有图层从零光栅化一次（全窗口重绘实测约 120ms），
这批欠账要几秒才能排空，之后静态层进入缓存才恢复。判断方法：

- 启动终端里 `[main] render mode: software` → 属于上述情况，改用硬件加速即可；
- `[main] render mode: gpu` 仍然卡 → 检查显卡驱动，或临时用 `-SoftwareRender` 对比确认。

## 打开文件夹 / 定位文件点了没反应（进程被降为低完整性级别）

现象：点「打开文件夹」「定位」以及底部那排文件夹按钮，状态栏显示「已请求打开…」，
但资源管理器窗口不出现；有时同时弹「Windows 无法访问指定设备、路径或文件」。
账号 / 设置也可能保存失败，启动器回退到程序目录下的 `data/`。

原因不在启动器代码，而在 **Windows 完整性级别**：如果 `electron.exe` 所在目录被打上了
`Mandatory Label\Low Mandatory Level` 标签，从该目录启动的进程会被降到 Low IL。
实测对照（同一个 `cmd.exe`）：

| 启动来源 | 进程完整性级别 |
| --- | --- |
| 从标了 Low 的目录启动 | `0x1000`（Low） |
| 从 `C:\Windows\System32` 启动 | `0x2000`（Medium） |

低完整性进程发出的「打开这个文件夹」请求交不到中完整性的资源管理器（UIPI 拦截），
`spawn explorer.exe` 也会继承低完整性令牌，于是**什么都不会发生**。同一台机器上
`electron.exe --version` 还可能直接以 `0xC0000005` 退出。

检查：

```powershell
icacls "<仓库>\electron\node_modules\electron\dist\electron.exe"
# 出现 Mandatory Label\Low Mandatory Level → 就是这个问题
```

修复（把整棵树重置为默认的 Medium）：

```powershell
icacls "C:\Users\<user>\Desktop\java" /setintegritylevel M /T
icacls "C:\Users\<user>\Desktop\java" /setintegritylevel (OI)(CI)M
```

`/setintegritylevel (OI)(CI)M /T` 只改到目录、**不会改已有文件**，必须用不带继承
标记的 `/setintegritylevel M /T` 才会逐个文件覆盖。

改完必须**完全退出启动器再重新双击 `启动.bat`**：已经在跑的那个进程还是 Low。

两个连带影响：

- 数据目录会从程序目录的 `data/` 切回 `%APPDATA%\mcdl-launcher-electron`（默认位置）。
  切换前先把前者里的 `accounts.json`、`game-directories.json`、`java-runtimes.json`、
  `scanned-game-dirs.json`、`launcher-settings.json`、`skins\` 拷到后者，否则会像「账号没了」。
- 这类标签通常由沙箱 / 受限运行环境写入。之后再从那种环境跑命令，标签可能被重新打上；
  启动器自检到低完整性时会在终端打印 `[env] 进程运行在低完整性级别（Low IL）`。

## 点「打开文件夹」弹出 Windows 原生错误框

典型文案：`Windows 无法访问指定设备、路径或文件。你可能没有适当的权限访问该项目。`
同类还有 `Windows 找不到…`、`你当前无权访问该文件夹`。

这三种文案来自不同的层，**不能靠文案反推原因**：

| 文案 | 谁弹的 | 含义 |
| --- | --- | --- |
| Windows 无法访问指定设备、路径或文件 | `ShellExecuteEx`（`shell.openPath` / `showItemInFolder`）失败 | 路径/设备这一层拿不到（盘符不在、UNC 不可达、外壳层被拦） |
| 你当前无权访问该文件夹 | 资源管理器自己（带「继续」按钮） | 目录 ACL 拒绝列目录 |
| Windows 找不到… | 外壳的「找不到文件」UI | 路径整段不存在 |

共同点是**调用方拿不到异常**，所以旧版启动器会「弹框 + 状态栏说打开成功」。现在
`openFolderPath()` / `revealPath()` 的做法：

1. `stat` 目标，不存在就 `mkdir`（`mods` 这类空目录很常见），存在但不是目录直接报错；
2. 用 `fs.opendir()` 试开一次，确认这一层**真的能列目录**；
3. Windows 上直接 `spawn` 绝对路径的 `explorer.exe`，并等 `'spawn'` / `'error'`；
4. 只有 `explorer.exe` 起不来才回退 `shell.openPath`，且检查它的**返回值字符串**
   （`openPath` 失败时是 resolve 而不是 reject，`.catch()` 永远不触发）。

注意 `fs.access(path, R_OK)` **不能**用来做这个预检：Windows 上它只看文件属性，
一个 deny 掉「列出文件夹内容」的目录照样返回成功（实测 `access=R_OK` 通过、
`readdir=EPERM`），必须用 `opendir()` / `readdir()`。

排查顺序：

```powershell
# 1. 主进程是不是新代码？（刷新按钮只重载渲染进程，见文末「改了代码但界面没变化」）
#    按住 Shift 点标题栏「刷新」会整进程重启

# 2. 看启动终端有没有回退日志
#    [open-folder] explorer 启动失败，回退 shell.openPath： <code>

# 3. 路径本身还在不在（移动硬盘拔了 / 网络盘断线最常见的假死）
Test-Path 'D:\你的\游戏目录'
icacls 'D:\你的\游戏目录'

# 4. 目录能不能真的列出来（这一步才会暴露 ACL 问题）
Get-ChildItem 'D:\你的\游戏目录' -ErrorAction Stop | Select-Object -First 1
```

如果是 ACL / 安全软件（受控文件夹访问、企业策略）拦的，启动器现在会自己在状态栏
报「无法访问这个文件夹（EPERM）：…」，不会再把用户丢给 Windows 的原生弹窗。

## 启动游戏失败

按钮上方的提示行会给出原因，常见对应关系：

| 提示 | 原因与处理 |
| --- | --- |
| 还没有选择账号 | 到「账户」页创建离线账号或登录微软账号 |
| 缺少客户端 jar | 实例文件不完整，重新安装该实例 |
| 缺少资源索引 `assets/indexes/<id>.json` | 安装时跳过了资源，用 `mcdl --install` 重新补全 |
| 没有找到可用的 Java N 运行时 | 到「设置」页手动指定 `java.exe`，或安装对应版本的 Java |
| 微软账号令牌已失效 | 到「账户」页重新登录 |
| 游戏已退出（code 非 0） | 查看 `<gameDir>/logs/latest.log` 的报错 |

`Failed to verify authentication`（HTTP 401）是离线账号的正常现象：游戏会尝试向官方校验会话，
失败后仍可进入单人游戏。

## 日志在哪

| 日志 | 位置 |
| --- | --- |
| 启动器自己抓的进程输出 | `<gameDir>\logs\mcdl-launcher-<时间戳>.log` |
| 游戏自身日志 | `<gameDir>\logs\latest.log` |
| 安装过程输出 | 实例管理页底部进度条，同时打印到启动终端 |
| 主进程日志 | 启动终端；标题栏问号按钮可打开应用日志目录 |

`<gameDir>` 默认为 `%APPDATA%\MCDL Launcher\.minecraft`。

## Chromium 缓存目录报错

在部分受限环境里，终端会刷出大量类似下面的错误：

```text
ERROR: ... Failed to create cache directory: ...\mcdl-launcher-electron\GPUPersistentCache
ERROR: ... Failed to create network context data directory ...\mcdl-launcher-electron\Network
```

这些是 Chromium 的磁盘缓存创建失败，属于用户目录权限限制，不影响界面与游戏启动，可以忽略；
需要消除时检查 `%APPDATA%\mcdl-launcher-electron` 的访问权限。

## 其他启动器实例没被识别

外部实例只有在点击「扫描实例」后才会被记录。若之前扫描过但目录已移动，删除缓存后重新扫描：

```text
%APPDATA%\mcdl-launcher-electron\scanned-game-dirs.json
```

## 改了代码但界面没变化 / 功能还是旧的

标题栏的「刷新」只重载渲染进程（window.location.reload()），**主进程（Node 侧）代码不会重载**。
改过 main.js / instance-store.js / ccounts.js / launch.js 等主进程文件后，必须完全退出再启动
（关窗口，或任务管理器结束 electron.exe 后重新双击 `启动.bat`）。

便捷做法：**按住 Shift 点标题栏的「刷新」**，会走 `app:relaunch` 整进程重启。

典型症状：界面是新的，但功能表现像旧版，例如模组页签显示
`目录：<游戏目录>\mods（目录不存在，导入时会创建）`，而实际模组在
`versions/<实例>/mods` —— 这就是主进程还在跑旧代码。
