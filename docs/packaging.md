# 打包与发版手册

> 适用版本：`electron/` 目录（MCDL Launcher · Electron 外壳 + `mcdl.jar` Java sidecar）
> 最近更新：随打包链路落地（electron-builder 26 / Electron 45），含更新通道与签名说明。

---

## 0. 一句话结构

```
MCDL Launcher.exe          ← Electron 外壳，只负责 UI + 编排
resources/app.asar         ← 主进程 js + renderer/ + node_modules(仅 electron-updater)
resources/mcdl/mcdl.jar    ← Java sidecar：版本清单 / 下载 / 解压 / 校验 / 整合包
resources/jre/             ← 可选内置 JRE（没有则回落用户已装 Java）
```

**为什么 jar 在 `resources/` 而不是 asar 里**：`java -jar` 需要一个真实文件路径，asar 是打包归档、java 读不了。所以 jar 走 `extraResources`，主进程用 `process.resourcesPath` 解析（`mcdl-service.js` 的 `resolveMcdlJar()`）。
**渲染层没有构建步骤**：`index.html` 里 `<script src="./renderer.js">` 是相对路径，`loadFile` 走 `file://`，不存在 Vite `base` / hash 路由那类坑。

---

## 1. 构建

```powershell
cd electron

# 只打目录（最快，用于验证包结构，不生成安装器）
npm run dist:dir          # → ..\dist\win-unpacked\

# 正式安装包（NSIS + portable）
npm run dist              # → ..\dist\MCDL Launcher-<version>-setup.exe 等

# 只要便携版
npm run dist:portable
```

前置：`npm install`（devDependencies 里的 `electron` / `electron-builder` 不会进包）。

### 产物自检（每次打包后建议跑一遍）

```powershell
npx asar list ..\dist\win-unpacked\resources\app.asar | Select-String node_modules
```

期望：只有 `electron-updater` 及其 15 个传递依赖；**不能**出现 `node_modules/electron`、`node_modules/electron-builder`；`tests/`、`data/`、`build/`、`scripts/` 都不在包里。

```powershell
Get-ChildItem ..\dist\win-unpacked\resources   # 必须有 app.asar / mcdl\mcdl.jar / jre\
```

---

## 2. 内置 JRE（可选，但推荐）

```powershell
npm run fetch:jre                 # 下载 Temurin JRE 21（默认国内镜像优先，失败回退官方）
npm run fetch:jre -- --official   # 只走 Adoptium / GitHub
npm run fetch:jre -- --mirror     # 只走清华 TUNA 镜像
npm run fetch:jre -- --force      # 覆盖已存在的
```

- 下载约 46 MB，**不要提交进仓库**（`.gitignore` 已排除 `/electron/jre/*`，只保留 `README.txt` 占位）。
- 脚本会先查 Adoptium assets 接口拿 SHA-256 / size，下载后校验通过才解压。
- 目录不存在会导致 `extraResources` 打包报错，所以 `jre/README.txt` 必须留着。
- 运行时解析顺序（`java-runtime.js`）：

```
MCDL_JAVA → 内置 JRE → 已扫描/登记的 JDK → JAVA_HOME → 常见安装目录 → PATH
```

- 只有「目录里真有 `bin/java.exe`」才算可用，占位 README 不会被误判。
- 一个内置 JRE 解决的是**首启可用**；具体某个版本要哪个 Java 由 `pickJava` 的合规规则决定（1.12.2 会锁 Java 8，没有就明确报错而不是硬塞 Java 21）。

---

## 3. 更新通道（默认关闭）

### 3.1 默认行为

- **未配置 = 完全不联网**：`isConfigured()` / `shouldAutoCheck()` 均为 `false`，`electron-updater` 连模块都不会被 `require`（实测 `require.cache` 里没有它）。
- 即使配置了：**只检查、不自动下载、不静默安装**（`autoDownload=false`、`autoInstallOnAppQuit=false`）。下载完要用户再点一次「重启并安装」。
- 开发态（`npm start`，`app.isPackaged=false`）即使配置了也只写日志不联网。

### 3.2 怎么开启

优先级（高 → 低）：

```powershell
# 1) 环境变量
$env:MCDL_UPDATE_URL="https://example.com/mcdl/updates"
$env:MCDL_UPDATE_CHANNEL="latest"        # 可选，默认 latest
$env:MCDL_UPDATE_AUTOCHECK="true"        # 可选：启动时静默检查

# 2) 文件：%APPDATA%\mcdl-launcher-electron\update.json
{
  "url": "https://example.com/mcdl/updates",
  "channel": "latest",
  "autoCheck": true
}
```

非法 URL / 非法 channel → 视为未配置（不会静默回落到另一个来源）。

**更新源必须 HTTPS**：`normalizeFeedUrl` 会拒绝公网明文 `http://`（视为未配置）。理由不是洁癖——`latest.yml` 和安装包是一起下发的，明文 HTTP 下中间人可以**同时**替换安装包和 yml 里的哈希，于是哈希校验完全失去意义。唯一例外是本机 / 私有网段（`localhost`、`127.0.0.1`、`::1`、`10.x`、`172.16–31.x`、`192.168.x`、`169.254.x`），用于局域网自测。

**托管建议**：不要用自建 VPS 挂静态目录（国内带宽成本高、并发一上来就卡在 0%）。用阿里云 OSS / 腾讯云 COS / Cloudflare R2 这类对象存储 + CDN，按量计费，把 `latest.yml` 和安装包放同一层目录，绑定域名即可。

### 3.3 发版流程（产出 latest.yml）

1. 解开 `electron-builder.yml` 末尾注释掉的 `publish:` 段，把 `url` 换成静态服务器根地址（必须与 `update.json` 一致）。
2. `npx electron-builder --win --publish never`
3. `dist/` 会出现：`latest.yml`、`MCDL Launcher-<v>-setup.exe`、`*.blockmap`
4. 把 **`latest.yml` + 同名 exe** 上传到该 url 根目录（blockmap 可选，不做差分也能装）。
5. `channel` 决定文件名：`latest.yml` / `beta.yml`，必须和客户端配置的 channel 一致。

> 只支持 **NSIS 安装版**。portable 与 `--dir` 产出的目录无法自更新（`quitAndInstall` 会失败并只记日志）。

---

## 4. 代码签名（强烈建议发正式版前搞定）

现在构建日志里会明确出现：`no code signing certificate configured, signing is skipped`。

**不签名的后果**：用户首次运行看到 SmartScreen「未知发布者」，部分杀软/企业策略会直接拦；自动更新能装但每次都会被提示。

配置方式（三选一，都通过环境变量，不要把证书提交进仓库）：

```powershell
# A. 证书文件（.pfx）
$env:CSC_LINK="C:\path\to\cert.pfx"
$env:CSC_KEY_PASSWORD="******"

# B. 证书存储（已导入 CurrentUser\My）
$env:CSC_NAME="Your Company Name"

# C. 云签名服务（Azure Trusted Signing 等）
# 按 electron-builder 文档配置 signtoolOptions / azureSignOptions
```

建议同时设 `$env:CSC_IDENTITY_AUTO_DISCOVERY="false"` 以外的情况要留意自动发现可能选错证书。

验证：构建日志不再出现 `signing is skipped`；`MCDL Launcher.exe` 右键 → 属性 → 数字签名 有项。

### 4.1 三条容易踩反的签名相关配置

| 说法 | 实际 | 我们怎么做 |
|---|---|---|
| 「没签名就把 `signAndEditExecutable` 设成 false」 | **错**。这个开关不只管签名，还负责把图标 / 版本信息 / 产品名写进 exe；关掉会连图标和版本号一起丢 | 保持 `true`（写资源、跳过签名），日志里 `signing is skipped` 是正常的 |
| 「没签名时 NSIS 更新会被拒绝覆盖」 | 取决于有没有 `publisherName`。electron-updater 只在 `app-update.yml` 里存在 `publisherName` 时才校验新旧包签名；我们当前**不生成** `app-update.yml`（用运行时 `setFeedURL`），所以不校验，未签名也能更新 | **不要**在没证书时加 `win.publisherName` —— 那会立刻开始校验签名，反而把更新链掐断 |
| 「用 zip 给内测，绕过安装器拦截」 | 有道理：zip 没有安装器，用户解压即用，不会被 360/管家拦在「安装」这一步 | 已在 `win.target` 里加 `zip`（`MCDL-Launcher-<v>-x64.zip`），和 portable 一起作为内测包 |

证书性价比：**先买 OV**（一年几百到一千多），不要一上来买 EV（几千上万 + 硬件 U 盾，不方便 CI）。OV 同样能消除 SmartScreen 红框（需要信誉积累），可以通过 `.pfx` 或云端 KMS 接入。

---

## 5. 打包后冒烟清单（只能真机跑）

按优先级，每条都能对应一类真实事故：

| # | 场景 | 期望 | 对应风险 |
|---|---|---|---|
| 1 | 目标机器**没装 Java**，双击安装版 | 能启动；「设置 → Java 管理 → 安装 Java」可下载并选中；版本列表能拉出来 | 首启白板 / `ENOJAVA` |
| 2 | 装到 `C:\Program Files`，随便改点设置 | 不报权限错误；数据落在 `%APPDATA%\mcdl-launcher-electron` | 只读目录写入 EACCES |
| 3 | 游戏目录/实例名带**中文 + 空格** | 扫描、启动、导出整合包都正常 | 路径编码 |
| 4 | 下载一个 **20 GB 整合包**，中途拖窗口、点取消 | UI 不卡死；取消真的中断（进度停、临时目录不被当成实例） | 主进程阻塞 / 取消无效 |
| 5 | 「更新整合包」合并过程中**强杀进程** | 重启后实例要么是完整旧版、要么是完整新版（不会半新半旧） | 合并原子性 |
| 6 | 断开网络启动 | 有明确提示，不崩溃 | 网络异常 |
| 7 | 安装后卸载 | 用户数据是否保留符合预期（当前 `deleteAppDataOnUninstall: false`） | 卸载残留 |
| 8 | 配好 `update.json` 后发一个高一版安装包 | 「检查更新」能发现；下载完点「重启并安装」能升级 | 更新通道 |
| 9 | 双开 | 只允许一个实例（`requestSingleInstanceLock`），第二个聚焦第一个 | 多实例抢文件 |
| 10 | 首次运行后看 `%APPDATA%\mcdl-launcher-electron\logs` | 有启动日志，无未捕获异常堆栈 | 可诊断性 |

---

## 6. 局域网自测更新链路（不用真服务器）

```powershell
cd electron
npm run dist                       # 先出安装包（更新只对 NSIS 安装版有效）
# 把 latest.yml 与安装包放进一个目录，然后：
npx http-server ..\dist -p 8080    # 任意静态服务器都行
```

在客户端（**必须是打包后的安装版**，开发态 `npm start` 会跳过）写：

```json
{ "url": "http://192.168.x.x:8080", "autoCheck": true }
```

`192.168.x.x` 属于私有网段，明文 http 是放行的（公网 http 会被拒）。

> 注意：`npx http-server` 只用于局域网自测；公网发版必须 HTTPS。

## 7. 故障速查

| 现象 | 先查 |
|---|---|
| 双击后窗口一闪就没 | `resources\mcdl\mcdl.jar` 是否缺失（缺会有 `ENOJAR`）；启动日志 `%APPDATA%\mcdl-launcher-electron\logs` |
| 启动器打开但版本列表空 | 本机没有可用 Java（`ENOJAVA`）→ 走「安装 Java」；或 `resources\jre\bin\java.exe` 不存在但你以为打了 JRE |
| 界面全白 | 极少见（渲染层无构建、全相对路径）；按 `Ctrl+Shift+I` 看 console，多半是 `renderer.js` 报错而不是资源 404 |
| 装到 Program Files 后设置存不住 | 看是否有人把数据目录写到了 exe 同级（应统一走 `app.getPath('userData')`） |
| 更新一直 `not-configured` | `update.json` 的 `url` 形状、`MCDL_UPDATE_URL` 是否被别处覆盖、channel 是否拼错 |
| 更新下载完点安装没反应 | 只有 NSIS 安装版支持；portable / 解包目录不支持 |

---

## 8. 相关文件

| 文件 | 作用 |
|---|---|
| `electron/electron-builder.yml` | 打包配置（files / extraResources / nsis / publish 注释） |
| `electron/build/icon.ico` | 应用图标（占位 256×256，可替换） |
| `electron/scripts/fetch-jre.js` | 下载并解压内置 JRE |
| `electron/updater.js` | 更新逻辑（纯逻辑 + 薄封装分层，默认关闭） |
| `electron/mcdl-service.js` | 解析 `mcdl.jar` 路径、选 Java、选可写 cwd |
| `electron/java-runtime.js` | Java 发现与合规选择（含内置 JRE、版本上限） |
