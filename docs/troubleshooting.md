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

排查顺序：

```powershell
.\node_modules\electron\dist\electron.exe --version          # 能打印版本 → 二进制本身正常
.\node_modules\electron\dist\electron.exe --no-sandbox --version
```

`启动.bat` 与 `run-electron.ps1` 默认已经带上 `--no-sandbox` 与 `--no-stdio-init`，
可以直接双击启动。

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
