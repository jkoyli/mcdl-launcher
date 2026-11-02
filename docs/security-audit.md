# MCDL Launcher 安全审计（Electron 渲染进程边界 / XSS→RCE 验证）

审计对象：本仓库 `electron/` 主进程与渲染层、`mcdl/` 内置下载器、各启动入口脚本。
审计方式：读代码 + 调用真实模块做攻击模拟 + 静态边界检查 + 真实启动验证。
测试只写系统临时目录，未触碰真实账号、真实游戏目录。

```powershell
node docs/security/audit.js          # 静态：配置底线 / IPC 校验 / 危险汇聚点
node docs/security/poc.js            # 攻击模拟：每条发现一个断言
node docs/security/runtime-check.js  # 运行时：真的启动一次，验证 IPC 与 CSP 生效
```

---

## 一、结论先说

回到那个问题：**启动器没有服务器，还需要防 XSS 吗？**

需要，但你们现在的实际情况和一般 Electron 应用不一样，结论要分两层：

1. **渲染层本身是干净的。** 38 处 `innerHTML` 赋值全部是"清空容器"、"写入白名单里的固定 SVG"或"写入 `escapeHtml()` 转义过的文本"（`page.target.innerHTML = html` 那两处，拼进去的每个不可信值都过了转义），没有任何一处把实例名、模组名、日志、Mod 描述这类外部文本原样拼进 HTML；渲染进程不发任何网络请求，也没有 iframe / webview / 内联脚本。也就是说：**当前代码里找不到 XSS 的注入点**——不是因为"没有服务器"，而是因为所有不可信文本都走了 `textContent`。

2. **但只要出现一处 XSS，它原先等于 RCE。** 这不是理论推演，是复现过的：主进程把渲染进程当成了可信调用方，`settings:save` 收下的 `javaPath` 会被 `execFile` 直接执行；`instances:content-toggle` 能把**任意路径**的文件改名；`instances:rename` 的别名能把 PowerShell 命令注入进生成的启动脚本。而且发布入口 `启动.bat` 用 `--no-sandbox` 启动，Chrome 的进程沙箱是关着的，`webPreferences.sandbox: true` 实际不生效。

   这几条已经在本次改动里堵上，并且有回归用例（`docs/security/poc.js`）逐条盯着，详见第六节。

一句话：**你们把第一道门（不渲染第三方 HTML）守住了，但门后原先是一条没有二道门的走廊。** 现在没有 XSS 不等于以后没有——下载中心 / 整合包面板已经把 mcdl 的远程版本清单和 zip 里的条目名带进了渲染层；这些内容目前都走 `textContent`，但这里正是最容易在下次改版里退化成 `innerHTML` 的地方。

---

## 二、发现清单

状态列：`已修复` = 本次改动完成并有回归用例覆盖；`部分` = 只修了一半；`待办` = 仅记录。
最初的审计基于提交 `529f61c`；`c7439b1` 落地下载中心 / 世界管理 / modrinth 之后重新核对过一遍，见第六节末尾。

| 编号 | 严重度 | 问题 | 位置 | 状态 |
| --- | --- | --- | --- | --- |
| F1 | 高 | `settings.javaPath` 可指向任意程序，启动器会执行它 | [main.js](electron/main.js)、[java-runtime.js](electron/java-runtime.js)、[launch-spec.js](electron/launch-spec.js) | 已修复 |
| F2 | 高 | 发布入口用 `--no-sandbox` 启动，进程沙箱整体关闭 | [启动.bat](启动.bat)、[run-electron.ps1](run-electron.ps1)、[package.json](electron/package.json) | 已修复 |
| F3 | 中 | `instances:content-toggle` 可重命名游戏目录之外的任意文件 | [instance-store.js](electron/instance-store.js#L314) | 已修复 |
| F4 | 中 | 实例别名未过滤换行 → 注入生成的 `.ps1` 启动脚本 | [launch-script.js](electron/launch-script.js)、[main.js](electron/main.js) | 已修复 |
| F5 | 中 | `instances:open-folder` 接受任意路径：`mkdir -p` + 交给资源管理器 | [path-guard.js](electron/path-guard.js)、[main.js](electron/main.js) | 已修复 |
| F6 | 中 | 没有 CSP，Electron 自己报警告 | [index.html](electron/renderer/index.html#L3) | 已修复 |
| F7 | 低 | `assertAppWindow` 只比 `event.sender`，不比 `senderFrame` / origin | [main.js](electron/main.js) | 已修复 |
| F8 | 低 | `jvmArgs` 自由文本可注入 `-javaagent:`；版本 JSON 的库路径可 `..` 穿透 | [version-manifest.js](electron/version-manifest.js)、[launch.js](electron/launch.js) | 部分（路径已堵，jvmArgs 未限制） |
| F9 | 信息 | `gamedirs:save` 接受任意绝对路径（含 UNC），落盘时会建目录并写固定 JSON | [main.js](electron/main.js) | 已修复（UNC 已拒） |
| F10 | 信息 | `authlib-injector.jar` 下载后不校验哈希，直接作为 `-javaagent` 加载 | [launch.js](electron/launch.js) | 待办 |
| F11 | 中 | `downloads:inspect-pack` / `install-pack` 接受任意本地文件路径（绕过了文件选择框） | [main.js](electron/main.js) | 已修复 |
| F12 | 中 | 生成的启动脚本把**有效访问令牌**写进 `.ps1` | [main.js](electron/main.js)、[launch-script.js](electron/launch-script.js) | 已修复 |

### 已经确认守住的（不要改坏）

- 81 个 `ipcMain.handle` **全部**调用了 `assertAppWindow`；
- `webPreferences` 三个底线都写了：`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`；
- `preload` 只暴露白名单 API（86 个方法），没有暴露 `ipcRenderer`；
- `setWindowOpenHandler` 一律 `deny`，`will-navigate` 拦掉窗口内跳转；
- `content-delete` / `content-delete-many` / `content-reveal` 都有 `path.relative` 越界校验；
- 内容类型走 `CONTENT_DIRS` 白名单，拼不出任意目录；
- 世界管理（[worlds.js](electron/worlds.js)）自带 `safeName` + `inside()` 校验，备份删除 / 还原都把目标钉在备份目录内；
- 账号令牌不下发渲染进程（`publicView` 只给 `hasToken` 布尔值）；
- 整合包面板的不可信文本也走 `textContent`：zip 条目名、清单名、包文件名都是纯文本写入；
- `mcdl` 侧对实例名做了 `sanitize()`（去掉 `\ / : * ? " < > |` 和换行、去掉结尾的点），`--name ..\..\x` 这种路径穿越写不出去；
- `tar.exe -xf` 解压 natives 时 bsdtar 会拒绝含 `..` 的条目（实测 `Path contains '..'`），zip-slip 不成立；
- 离线皮肤校验 PNG 头 + 尺寸，皮肤缓存文件名是哈希，不构成任意文件写。

---

## 三、攻击链（修复前的复现记录）

下面这些是**修复前**跑通的东西，留作对照。现在同样的输入都会被拒绝，回归用例见第六节。

### F1 · `javaPath` → 任意程序执行（高危）

主进程"选 Java"的流程是：设置里的 `javaPath` 非空 → `javaRuntime.probe(javaPath)` → 而 `probe()` 就是 `execFile(javaPath, ['-XshowSettings:properties', '-version'])`。这个路径只校验了"是字符串"，没有校验"是 Java"。

攻击者用 csc 编一个伪装成 Java 的 exe（往 stderr 打印 `java.specification.version = 17`），实际输出：

```
probe() 结果: {"path":"...\\fakejdk\\evil-java.exe","major":17,"version":"17.0.9",...}
[确认] probe 已经执行了攻击者的程序
[确认] buildLaunchPlan 把攻击者路径当作 javaPath
---- 攻击者程序收到的命令行 ----
executed args=[-XshowSettings:properties | -version]      ← 探测阶段就执行了一次
executed args=[-Xmx2048M | -Dfile.encoding=UTF-8 | ... | -cp | ...poc.jar | net.minecraft.client.main.Main | --version | poc | --username | Steve]
[确认] 启动实例时主进程用完整 Java 参数拉起了攻击者的 exe
```

注意两点：

- **不用等用户点"启动游戏"**：走一次"启动实例"或"生成启动脚本"就会触发探测；
- `javaExecutableForSpawn()` 会把 `xxx-java.exe` 换成同目录的 `xxx-javaw.exe`，攻击者同时放一个同名副本，完整参数就会送到他手上。

### F2 · `--no-sandbox`（高危）

`启动.bat` 和 `run-electron.ps1` 原本都是：

```bat
start "" "node_modules\electron\dist\electron.exe" --no-stdio-init --no-sandbox . %*
```

`--no-sandbox` 不只是"少一层保护"：它把整个应用的 Chromium 进程沙箱关掉，`webPreferences.sandbox: true` 会被忽略（Electron 的 `--no-sandbox` 优先级高于窗口配置）。渲染进程一旦被 V8/Chromium 层面的漏洞或某个特性绕过打穿，就直接是宿主代码执行。

### F3 · 任意文件改名（中）

`instances:content-toggle` 只确认"实例存在"，然后把 `payload.path` 原样交给 `setModEnabled()`；后者只做 `path.resolve` + `fs.rename`，**没有 containment 校验**。对比同一文件里的 `deleteContent()`，它是有 `inside(root, target)` 检查的——校验是能做的，只是 toggle 漏了。

```
目标文件: C:\Users\...\Temp\mcdl-sec-audit\victim\important-document.txt
返回路径: ...\important-document.txt.disabled
[确认] 游戏目录之外的文件被成功改名
```

影响：任意文件"重命名一次"（加或去 `.disabled` 后缀）。单独看破坏性中等，但它是很好的组合件——可以把某个 `.exe`/`.jar` 改名、把配置改成程序认不出的名字、把 `.disabled` 的文件"激活"。

### F4 · 启动脚本命令注入（中）

`instances:launch-script` 生成的 `.ps1` 里，第 2 行是：

```js
`# 实例：${instance.displayName || versionId}`
```

`displayName` 来自 `instances:rename` 写进 `instance-display-names.json` 的别名，而 rename 只做了 `trim()` 和长度检查，**不拦换行**。别名里塞一个 `\r\n`，注释行就被截断，后面的内容成了脚本正文：

```
 1| # 由 MCDL Launcher 生成，可直接双击运行
 2| # 实例：我的实例
 3| Start-Process -FilePath calc.exe     ← 攻击者注入的命令
 4| #
 5| Set-Location -LiteralPath '...'
```

用 PowerShell 的 AST 解析确认过，第 3 行是一个真正的 `CommandAst`（`Start-Process`），不是注释。`plan.args` 那些参数是用 `psQuote()` 单引号包裹的（`''` 转义正确），所以注入点只有这一处注释行。

### F12 · 令牌被写进启动脚本（中）

顺带发现的、比"诊断包泄露"更现实的一条：版本 JSON 的 game 参数里有 `--accessToken ${auth_access_token}`（本机 `1.20.1.json` 里就有），所以 `plan.args` 里是明文令牌，而生成脚本时是把 `plan.args` 逐条写进 `.ps1` 的——**用户的活令牌被持久化在实例目录里**。用户把这个脚本发给别人求"帮我看看为什么启动不了"是很自然的行为。

进程命令行带令牌是所有 MC 启动器的通病（WMI 可读），但**落到文件里**是可避免的。

### F5 / F9 / F11 · 任意路径（中）

```js
ipcMain.handle('instances:open-folder', async (event, payload = {}) => {
  const target = String(payload.path || '');
  if (target) return { path: await openFolderPath(target) };   // ← 没有白名单
```

`openFolderPath()` 会 `path.resolve` → 不存在就 `mkdir(recursive)` → 再交给 `explorer.exe`。所以渲染进程可以：

- 在任意可写位置**创建目录树**；
- 让资源管理器打开 UNC 路径（`\\attacker\share`）：Windows 会为此发起 SMB 认证，攻击者拿到当前用户的 NTLM 响应，可用于中继 / 离线破解。**而且泄露发生在 `fs.stat` 那一刻**，比"交给 explorer"更早。

同类问题还有：`downloads:inspect-pack` / `install-pack` 直接吃 `payload.file`（`pick-pack` 才是走对话框的），`gamedirs:save` 接受 UNC。

### F6 · 没有 CSP（中）

`index.html` 里原本没有 `Content-Security-Policy`，Electron 自己会打警告：

```
Electron Security Warning (Insecure Content-Security-Policy) This renderer process has either no Content Security
Policy set or a policy with "unsafe-eval" enabled.
```

CSP 不能防住"代码里已经写了 innerHTML 拼字符串"，但它能挡住 XSS 的常见落地形态（内联脚本、`eval`、外部脚本、`data:` 文档），是渲染层的最后一道保险。对启动器还有额外收益：页面本来不需要联网，`connect-src 'none'` 直接掐掉"XSS 之后把数据外传"这条路。

### F7 · IPC 只认 webContents（低）

```js
function assertAppWindow(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Unauthorized IPC sender');
  return mainWindow;
}
```

`event.sender` 是 webContents 级对象，**同一个窗口里的子框架拿到的是同一个值**。现在没有 iframe / webview，而且 `nodeIntegrationInSubFrames` 没开、preload 不会进子框架，所以暂时打不穿。但这是"以后加一个 iframe 就静默失效"的写法。

### F8 · `jvmArgs` 与版本 JSON（低）

- `settings.jvmArgs` 是自由文本，经 `splitCommandLine()` 拆开后直接进 JVM 参数。塞 `-javaagent:` / `-agentpath:` / `-Dlog4j.configurationFile=` 都能生效。
- 版本 JSON 的 `downloads.artifact.path` / `name` 会被直接 `path.join(librariesDir, artifact)`，写成 `..\..\..\x.jar` 就能把 classpath 指到游戏目录外（恶意整合包 / "扫描其他启动器"扫到的第三方实例可利用）。

### F10 · 供应链（信息级）

`authlib-injector.jar` 从官方地址下载后不校验哈希就当 `-javaagent` 加载。中间人或者上游被投毒就是 RCE。

---

## 四、优先级建议

1. **F2**（删 `--no-sandbox`）：一行改动，把"渲染进程被攻破"从"宿主沦陷"降级成"渲染进程沦陷"。
2. **F4 / F12**（脚本模板化）：cheap，而且顺手解决令牌落盘。
3. **F3 / F5 / F11**（一个路径助手管三处）：同一条错误模式。
4. **F1**（`javaPath` 可信校验 + LaunchSpec）。
5. **F6 / F7**：渲染层保险，为以后接远程内容提前铺好。
6. **F8 jvmArgs / F10**：按季度清理。

---

## 五、可以接进 CI 的检查

三份脚本，各管一层：

```powershell
node docs/security/audit.js          # 静态：配置底线 / IPC 校验 / 危险汇聚点（命中高危退出码 1）
node docs/security/poc.js            # 攻击模拟：每条发现一个断言，攻击应全部被挡住
node docs/security/runtime-check.js  # 运行时：真的启动一次，验证 IPC 与 CSP 在运行时生效
```

`audit.js` 检查：handler 是否都有调用方校验（且带 `senderFrame`）、三个 `webPreferences` 底线、默认启动脚本里是否混进 `--no-sandbox`、CSP 的 `script-src` 是否干净、`innerHTML` 是否还都只用于清空 / 白名单 SVG / 转义后的文本、高价值 IPC 的入参是否还直通文件系统。

`runtime-check.js` 只启动一个临时实例（`--multi-instance` + 调试端口），验证：页面在 CSP 下正常渲染、preload 桥可用、IPC 真的能通（防止 `senderFrame` 校验写太严把功能掐死）、`openExternal` 仍只吃 http(s)、CSP 能挡住内联 `<script>` 与内联 `onerror=`。

---

## 六、本次修复（做了什么，怎么验证的）

> 这一节记录两轮：第一轮把边界收紧到"入口白名单"；第二轮按"使用点能力校验"重做了
> javaPath / 整合包 / open-folder 三处，避免误伤自定义 JDK、拖拽和 normal 的打开文件夹。
> 第二轮在 `security/f1-f4` 分支上完成。

### 新增的边界模块

| 文件 | 作用 |
| --- | --- |
| [path-guard.js](electron/path-guard.js) | 三段式路径校验：词法拒 UNC/设备路径 → realpath（解析 junction）→ 越界判定；越界一律 `code=EPATH_OUTSIDE`、消息含 `outside roots` |
| [launch-spec.js](electron/launch-spec.js) | **唯一**产出"可执行文件 + 参数"的地方；`assertJava` 回调是使用点授权校验，新调用方也绕不过 |
| [launch-script.js](electron/launch-script.js) | `.ps1` 固定模板 + `launch-data.json`；令牌用占位符，运行时从账号数据读 |
| [modpack-guard.js](electron/modpack-guard.js) | 整合包预检（条目 / 大小 / 链接条目）+ 一次性 token + 解压后 `verifyExtractedTree` 核对 |
| [java-runtime.js](electron/java-runtime.js) · 授权表 | javaPath 的授权与指纹（见下） |

### javaPath：从"入口白名单"改成"授权表 + 使用点校验"

- 授权表元素是**身份**不是路径：`{ real, size, mtimeMs, major }`。授权的是"这个文件"。
- 唯一会执行"尚未授权的可执行文件"的两个时刻，都已写进代码注释：
  1. `settings:pick-java`（用户通过对话框显式选择，主进程 `realpath + stat + probe` 一次）；
  2. 启动器自己枚举出来的 Java（`JAVA_HOME` / `PATH` / `MCDL_JAVA` / `SCAN_ROOTS` / 上次扫描结果）。
- 失效策略：指纹变化 → 授权作废；**不自动重跑 probe**（那等于执行一个已被替换的二进制），
  直接报"在授权之后被修改过，请重新选择"。
- 持久化：`settings.json` 的 `javaIdentity`；启动时只比对指纹（不执行），对不上就丢弃记录。
- 使用点：`launchInstance` → `createLaunchSpec(plan, { assertJava })`，即使调用方绕过
  `resolveJava` 直接塞路径也会被拒（用例 F1-5 专门盯这个）。
- **不再静默回退**：配置了自定义 Java 却不可用 → 直接报错，不再偷偷换成自动探测到的版本。
- 比对的是**可执行文件的真实路径**，不是它所在目录——Oracle 的 `java8path_target_*` 是 junction，
  目录白名单会误伤（实测过，见用例 F1-6）。

### 整合包：保留拖拽，把校验重心移到内容

- `downloads:pick-pack`（对话框）和 `downloads:prepare-pack`（拖拽）走**同一条**预检管线；
- 预检：`lstat` 普通文件、扩展名、条目数 / 单文件 / 总量 / 压缩比上限、拒绝 `..` / 绝对路径 /
  盘符 / ADS / 保留名 / 尾随点空格、拒绝链接条目（unix mode 或 reparse 位）；
- 通过后发**一次性 token**（10 分钟、用后即失效）；`install-pack` 只认 token，不认路径，
  安装前再核对文件指纹没变；
- 解压后 `verifyExtractedTree` 扫一遍实例目录：出现符号链接 / 指到目录外的路径就整体删掉并报错。

### open-folder：三段式，含 junction 回归

1. 词法拒 UNC / 设备路径（`fs.stat` 就会触发 SMB 认证，必须在此之前）；
2. 对目标与允许根都取 realpath（目标不存在时取最近的已存在祖先再拼回）；
3. 越界抛 `outside roots`，之后才 mkdir / 交给资源管理器。

`instances:content-reveal` 与 `instance-store` 的启停 / 删除也换成了 realpath 版，
因为 `mods/` 里放一个指向 `C:\Windows` 的 junction 同样能逃出去。

### 验证

```
node docs/security/audit.js          83 个 handler，0 条高危（exit 0）
node docs/security/poc.js            26 / 26 通过（exit 0）
node docs/security/runtime-check.js  12 项全过（含功能冒烟，exit 0）
```

`poc.js` 的 26 条每条都标注"对应修复项 + 期望的具体错误原因"，例如 junction 那条断言的是
`outside roots` 而不是"是否被拒"——退化成 ENOENT 也会红。清单：

| # | 修复项 | 断言 | 期望原因 |
| --- | --- | --- | --- |
| 1 | F2 | 默认启动脚本不带 `--no-sandbox` | 无该参数 |
| 2 | F2 | 启动时打印生效的 webPreferences + 检测危险开关 | 存在运行时断言 |
| 3 | F3 | 游戏目录外的文件不能改名 | `outside roots` |
| 4 | F3 | mods 内的模组仍可禁用 | 功能正常 |
| 5 | F3 | `deleteContent` 越界同样 `outside roots` | `outside roots` |
| 6 | F4 | 脚本正文与实例名无关 | 两次渲染一致 |
| 7 | F4 | 正文不含注入命令 / 实例名 | 无泄漏 |
| 8 | F4 | 实例名只作为数据出现在 json | 数据不参与解析 |
| 9 | F4 | PowerShell AST 无 `Start-Process` | 命令集合固定 |
| 10 | F4 | 生成的脚本仍能正常启动 | 功能正常 |
| 11 | F12 | json 里只有令牌占位符 | 无真实令牌 |
| 12 | F12 | `.ps1` 正文不含真实令牌 | 无真实令牌 |
| 13 | F1 | `%TEMP%` 下未登记的伪装 Java 被拒 | `未授权的 Java 路径` |
| 14 | F1 | 非 java 名字的 exe 被拒 | `必须指向 java.exe` |
| 15 | F1 | 参数不是字符串数组被拒 | `参数只能是字符串` |
| 16 | F1 | 授权后文件被替换 → 指纹失效 | `授权之后被修改过` |
| 17 | F1 | 绕过 resolveJava 也过不了使用点校验 | `未授权的 Java 路径` |
| 18 | F1 | 本机真实 Java 不被误伤（Oracle junction 路径） | 功能正常 |
| 19 | F5 | UNC 路径被拒 | `网络路径或设备路径` |
| 20 | F5 | 设备路径被拒 | `网络路径或设备路径` |
| 21 | F5 | 数据目录内指向 System32 的 junction 被拒 | `outside roots`（非 ENOENT） |
| 22 | F5 | 数据目录内的真实子目录仍可打开 | 功能正常 |
| 23 | F11 | 合法整合包能过预检拿 token | 功能正常 |
| 24 | F11 | 含 `..` 条目被拒 | `条目使用 .. 穿越` |
| 25 | F11 | 含符号链接条目被拒 | `链接条目` |
| 26 | F11 | 没有 token 不能安装 | `安装许可无效或已使用` |

功能冒烟（`runtime-check.js`，真的启动应用走 IPC）：实例列表可用、自定义 Java 对话框入口存在、
`open-folder` 对已登记实例仍能打开、合法整合包能拿 token、伪造 token 不能安装、
未授权 `javaPath` 写不进设置。

### 需要人工做的两件事（自动化做不了）

1. **系统对话框登记自定义 JDK**：对话框无法脚本化。请手动点「设置 → Java → 选择 Java…」，
   选一个扫描不到的 JDK，确认保存后能启动游戏（这一步同时验证 `java8path` 之类的 junction 路径）。
2. **真实恶意包的手动验收**：在真机放一个指向 `C:\Windows\System32` 的 junction 点"打开文件夹"，
   确认拒绝且 System32 下无新增；拖一个含符号链接条目的 zip，确认拒绝且目标目录外无文件。

### 顺带核对：`c7439b1` 新进来的功能

下载中心 / 世界管理 / modrinth 让 handler 从 60 涨到 81、preload 从 64 涨到 86 个方法，所以重新核了一遍：

- 世界管理（[worlds.js](electron/worlds.js)）自带 `safeName` + `inside()` 校验，备份删除 / 还原都把目标钉在备份目录内——这几处不用改；
- 整合包 / 模组面板渲染的是 `textContent`；`page.target.innerHTML` 那两处虽然拼 HTML，但每个不可信值都过了 `escapeHtml()`，属于安全用法；
- 新增的 `downloads:*` 两个 handler 原本吃任意路径，已并入 F11 的修复。

### 仍然待办

- **F8 的 `jvmArgs`**：还是自由文本，`-javaagent:` / `-agentpath:` 仍可注入。要根治得把它解析成受限模型（只放行 `-Xmx/-Xms/-XX:` 白名单或纯数值）。现在它被 F1 的 javaPath 校验挡在门外（注入的 agent 还得先落到磁盘），风险降了一档但没消失。
- **F10**：`authlib-injector.jar` 下载仍不校验哈希。
- 第三方实例 / 恶意整合包里的版本 JSON 仍可写任意 `arguments.jvm`。启动别人的整合包本来就等于执行它的代码，这条属于"知情同意"范畴；但如果以后做"一键安装在线整合包"，建议在启动前展示将要使用的 JVM 参数。

---

## 七、没覆盖到的

- 没有做 `mcdl.jar` 本身的审计（Java 侧的下载校验、压缩包解压路径），只在调用边界上看了参数；
- 没有对打包产物（asar / 安装器 / 签名）做检查，当前是从源码目录直接跑的；
- 微软登录用的是 `login.live.com` 的 desktop 回调流程，没有做 OAuth 中间人分析；
- 没有测试真实游戏启动后的进程边界（子进程继承的令牌、`javaw.exe` 的生命周期）。

---

*复现脚本：`docs/security/poc.js`（攻击模拟 / 回归）、`docs/security/audit.js`（静态检查，输出 `docs/security/audit-report.txt`）、`docs/security/runtime-check.js`（运行时自检）。*
