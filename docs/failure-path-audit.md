# 失败路径审计：PCL2 / HMCL 的历史 bug 在本启动器的复现情况

审计对象：`electron/`（Node 引擎 + 渲染进程）与 `mcdl/`（Java 安装后端）。
结论优先，每一条都给出可核对的代码位置与实测证据。

本文是**失败模式的唯一清单**：每一类失败、修复前的判定、修复点与测试都在这里。
给开发者的硬约束写在[开发文档](development.md)，用户可见的症状与处理写在[排障](troubleshooting.md)，
这两处只做链接，不再复述清单。

> **阅读提示**：从「结论速览」到「建议实施顺序」是**修复前**的快照，里面的行号是当时的；
> 加固后代码整体位移（`main.js` / `launch.js` 都长大了），行号已不可靠。核对现状请按符号名搜索
> （例如 `verifyLaunchPlan`、`RENDERER_CRASH_LOOP`、`beginShutdown`）。「已落地的修复」一节按
> 文件 + 符号记录，不依赖行号。

---

## 结论速览

> 状态：本报告发现的问题**已全部修复**（见文末「已落地的修复」；报告里标「经核实」的部分是逐条
> 比对代码后补的更正）。下表保留的是修复前的判定，用来说明「为什么当时的架构会原样复现这个错误模式」。

| # | PCL2 / HMCL 的错误模式 | 修复前是否复现 | 修复前的严重度 |
|---|---|---|---|
| 1 | 关键文件缺失仍拉起游戏（Authlib-Injector 失败后继续启动） | **部分复现**：authlib 这条具体路径已堵住，但「依赖库 / natives 缺失」仍带病 spawn | **高** |
| 2 | `render-process-gone` 无人监听 → 静默白屏 → 用户强杀 | **完全复现**：只 `console.error`，无 reload、无崩溃循环判定、无静态恢复页 | **高** |
| 3 | 崩溃后才分析日志（事后诊断）而不是启动前拦截 | **复现**：唯一的失败反馈是「非 0 退出码 → 弹崩溃窗口」 | 中 |
| 4 | Java 版本不匹配悄悄换用/继续 | **复现**：只打 `console.warn`，然后照常启动 | 中 |
| 5 | spawn 失败被当成正常退出 | **复现**：`code === null` 被格式化进 `Number()`，判成 0 | 中 |

已确认**没有**踩的坑：authlib-injector 下载失败会抛异常中止启动；客户端 jar 缺失、资源索引缺失、版本 JSON 缺失都会显式抛错（见下方「已守住」一节）。

---

## 1. 「关键文件完整性闸门」缺失（高）

### 现状

`electron/launch.js` 的 `buildLaunchPlan()` 是拉起 Java 之前的最后一道关口。
其中三件事做了硬校验，两件事只记 warning：

```js
// launch.js:349-352 —— 缺失的库只收集，不拦截
const missingLibraries = [];
for (const entry of fullClasspath) {
  if (!(await manifest.exists(entry))) missingLibraries.push(path.basename(entry));
}

// launch.js:358 —— 缺失的 natives 只收集，不拦截
const missingNatives = await prepareNatives(natives, nativesDir);

// launch.js:493-501 —— 全部塞进 warnings 返回
warnings: [
  ...(missingLibraries.length > 0 ? [`${missingLibraries.length} 个依赖库文件缺失，可能无法启动…`] : []),
  ...(missingNatives.length > 0 ? [`${missingNatives.length} 个 natives 包缺失…`] : []),
  ...(skipped.length > 0 ? [`${skipped.length} 个 library 无法解析路径`] : [])
]
```

`launchInstance()` 拿到 plan 后不做二次判断，直接 `createLaunchSpec()` → `spawn()`
（`launch.js:552-572`）。`createLaunchSpec()` 只校验**形状**（可执行文件名、参数类型、路径是否绝对），
不校验**内容是否存在**（`launch-spec.js:64-87`）。

### 为什么等于「带病前进」

- classpath 里保留着不存在的 jar。Java 启动后 `ClassNotFoundException` / `NoClassDefFoundError`
  → 进程秒退 → 用户看到「游戏闪退」。
- natvies 缺失时 `-Djava.library.path` 指向空目录，表现为 `UnsatisfiedLinkError` 或 LWJGL 初始化失败。
- `skipped`（`version-manifest.js:294/304`，路径越界或被判定无法解析的 library）**被静默从 classpath 里丢掉**，
  只折算成一句 warning。第三方整合包的版本 JSON 一旦触发这条路径，就是「少一个库、照样启动」。

### 实测证据

用一份最小版本 JSON（一个库文件不存在，其余齐全）调用真实的 `buildLaunchPlan()`：

```
=== 结论：buildLaunchPlan 没有抛错，返回了可 spawn 的计划 ===
warnings = [ '1 个依赖库文件缺失，可能无法启动（例：missing-core-1.0.jar）' ]
args 里仍然包含缺失的 jar = true
```

### 更糟的是：warning 到不了用户眼前

`main.js:4073` 把 `warnings` 原样返回给渲染进程，但两个启动调用点都**没有读这个字段**：

- 首页大按钮：`renderer.js:668-686`（只看 `result.ok` / `versionId` / `javaMajor` / `memoryMb`）
- 实例启动/测试启动：`renderer.js:6328-6349`（只用 `pid` / `javaMajor`）

在 `renderer.js` 里全局搜索 `warnings`，唯一命中是壁纸导入（`renderer.js:5649`）。
也就是说这层 warning 在 UI 上**等于不存在**，链路退化成了纯「闪退后再看日志」。

### 正确形态（建议）

在 `launchInstance()` 里、`createLaunchSpec()` 之前加一道闸门，产出结构化而不是字符串化的失败清单：

```js
// 建议：launch.js，spawn 之前
const preflight = await verifyLaunchFiles(plan, { checkHash: settings.verifyOnLaunch });
if (!preflight.ok) {
  const err = new Error(
    `实例文件不完整，已中止启动（未拉起 Java）。\n` +
    `缺失 ${preflight.missing.length} 项：${preflight.missing.slice(0, 5).join('、')}` +
    (preflight.missing.length > 5 ? ` 等 ${preflight.missing.length} 项` : '') + '\n' +
    `可在「实例管理 → 修复文件」重新下载缺失文件。`
  );
  err.code = 'LAUNCH_PREFLIGHT_FAILED';
  err.details = preflight;              // { missing:[{path,kind,expectedSize,actualSize}], corrupt:[...] }
  throw err;
}
```

闸门至少要覆盖：

1. `versions/<id>/<id>.jar`（已覆盖，但应并入统一清单）
2. classpath 里**每一个**条目：存在 + 大小 > 0（+ 可选 SHA-1 与版本 JSON 的 `downloads.artifact.sha1` 对比）
3. `assets/indexes/<id>.json`（已覆盖）+ 索引里声明的对象抽查
4. natives jar → 解压产物（当前只看 jar 在不在，不看解压结果是否为空）
5. `logging.client.file`（可选，缺失不该阻断）
6. 第三方账号的 `authlib-injector.jar`（存在 + 大小下限 + 可选 SHA-256）

配套动作：`instances:maintenance` 目前只有 `redownload-assets` / `remove-assets` / `remove-libraries` / `clean`
（`main.js:3185-3249`），缺一个「按闸门报告修复」的 `repair`，否则用户拿到清单也不知道怎么办。
（最终落地的形态是独立的 `launcher:repair` IPC ＋ 实例管理菜单「检查并修复缺失文件」，
**没有**往 `instances:maintenance` 里加 `repair` 动作；见文末 P0-1。）

---

## 2. Authlib-Injector 这条具体路径：已堵住，但校验仍是空白

```js
// launch.js:270-298
if (!(await manifest.exists(jar))) {
  ... 下载；HTTP 失败 / 文件 < 1024 字节都 throw
}
return `-javaagent:${jar}=${apiRoot}`;
```

下载失败会抛错 → `buildLaunchPlan()` 失败 → `launcher:launch` catch → `send({ phase: 'error' })` → 渲染进程红字提示，
**不会**落到「拉起 Java 再闪退」。这一点明确优于 PCL2 当年的行为。

仍存在的空洞（建议补，但不算高优）：

- `latest.json` 里通常带 `checksums`，这里**没有校验**。CDN 返回一个 >1KB 的 HTML 错误页也能通过 `length < 1024`。
- 已有文件只判存在，不判完整性。历史上一次被中断的下载留下了截断 jar，会**永久命中缓存**，
  之后每次启动都带着 `-javaagent` 一个坏 jar，表现为每次启动都闪退。
- `fs.writeFile` 非原子；建议写临时文件后 `rename`，并校验哈希。

> 以上三条已在 P2 落地（缓存体检 + 校验哈希 + 原子写），见「已落地的修复 → P2」。

---

## 3. 渲染进程崩溃：完全复现（高）

### 现状

```js
// main.js:4482-4488
mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
  console.error('[main] renderer failed to load:', errorCode, errorDescription, validatedURL);
});

mainWindow.webContents.on('render-process-gone', (_event, details) => {
  console.error('[main] renderer process gone:', details);   // ← 到此为止
});
```

没有 `reload()`、没有崩溃计数、没有恢复页、没有 `unresponsive` 监听。
窗口 `show: false` + `ready-to-show` 才显示（`main.js:4439/4495-4498`），
所以「加载期间渲染进程就死了」的情况连白屏都看不到，只剩一个后台进程。

GPU 那条路径反而是做得对的，可以照抄它的形状：

```js
// main.js:209-225：GPU 崩溃 → 记录标记 → 以 --software-render 重启一次，不会循环
// main.js:108-135：gpu-crash.json 标记 + 7 天 TTL
```

渲染进程缺的正是这套「分层恢复」。

### 建议：三级恢复

```js
// main.js
const rendererCrashes = [];           // 时间戳队列，窗口级
const CRASH_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

mainWindow.webContents.on('render-process-gone', (_event, details) => {
  appLog.append('ERROR', `[renderer-gone] reason=${details.reason} exit=${details.exitCode}`);
  if (!mainWindow || mainWindow.isDestroyed()) return;

  rendererCrashes.push(Date.now());
  while (rendererCrashes.length && Date.now() - rendererCrashes[0] > CRASH_WINDOW_MS) rendererCrashes.shift();

  if (rendererCrashes.length < CRASH_LOOP_THRESHOLD) {
    // L1：单次崩溃 —— 直接重载
    mainWindow.reload();
    return;
  }
  // L2：崩溃循环 —— 换零依赖静态页（不加载 React/Vue 主包，主包本身可能就是崩溃原因）
  rendererCrashes.length = 0;
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'recovery.html'));
});

mainWindow.webContents.on('did-fail-load', (event, code, desc, url) => {
  // 主文档加载失败不该只留一行日志
  if (event && url && /index\.html/i.test(url)) {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'recovery.html'));
  }
});

mainWindow.on('unresponsive', () => { /* 提示 + 可选强制 reload */ });
```

`renderer/recovery.html` 要求：

- 纯静态、零 JS 依赖、内联样式，`loadFile` 直接可读（不经过主包、不经过 preload 的复杂依赖）；
- 三个按钮：**重新加载**（`ipcRenderer.invoke('recovery:reload')` 或直接 `location.href = 'index.html'`）、
  **重置工作区**（清 Chromium profile / Local Storage，保留账号与实例数据）、
  **导出诊断**（把 appLog、`gpu-crash.json`、当前渲染崩溃记录打包到桌面）；
- 显示崩溃原因与时间，别让用户面对一句「出错了」。

注意：`webPreferences.sandbox: true` + `contextIsolation: true`（`main.js:4449-4451`），
恢复页如果要用 IPC，需要在 preload 里暴露一个最小白名单方法，别为此打开 `nodeIntegration`。

### 顺带：`did-fail-load` 也会静默白屏

同一个页面加载失败（磁盘错误、文件被杀软隔离）时也只有一行日志。上面的 `did-fail-load` 分支一并解决。

---

## 4. spawn 失败被当成正常退出（中）

`launch.js:566-617`：

- `spawn()` 的 `ENOENT` / `EACCES` 是**异步** `'error'` 事件，`try/catch` 抓不到；
- 之后 `'close'` 会带着 `code === null` 触发，`main.js:4035` 判断用的是 `Number(data.code) !== 0`，
  而 `Number(null) === 0` → **判成正常退出**；
- 同时 `launchInstance()` 已经返回、`launcher:launch` 已经回了 `ok: true`，
  渲染进程先显示「已启动 · PID -」，然后什么都不发生。

用户视角：点了启动 → 显示「已启动」→ 游戏没出来 → 无任何错误。这比闪退更难排查。

修法：`spawn` 后用 `once('spawn')` 建立「已真正创建进程」的信号，`'error'` 事件里把
`code` 置为显式失败（例如 `signal: 'spawn-error'`），渲染进程按失败处理；`launchInstance` 应等到
`'spawn'` 或 `'error'` 先到者再 resolve，而不是 spawn 后立刻 resolve。

---

## 5. Java 版本不匹配只 warning（中）

```js
// main.js:744-746
if (requiredMajor && info.major < requiredMajor) {
  console.warn(`[launch] configured Java ${info.major} is below required ${requiredMajor}`);
}
return info;
```

用户手动选了 JDK 17，去启动需要 21 的版本（1.20.5+），启动器打一行日志就照常 spawn，
游戏侧抛 `UnsupportedClassVersionError` → 又是「闪退」。这里要么显式中止，要么在启动按钮上先给出
「该实例需要 Java 21，当前 17」的强提示并要求确认。注意 `resolveJavaRuntime` 已经明确不做静默回退
（`main.js:735-742` 的注释），这个判断应该同样硬起来。

---

## 6. 退出码语义：只有非 0 才弹崩溃窗口（低）

`main.js:4035` / `renderer.js:9797`。以下情况都不会弹崩溃窗口：

- 退出码 0 但游戏其实没起来（配错 `mainClass` 的整合包、`--demo` 之类参数被吞）；
- 上面的 `code === null`（spawn 失败）；
- 游戏在生成 crash-report 之前就被原生库干掉（`findCrashReport` 找不到报告，但退出码非 0 仍会弹窗，这条 OK）。

建议加一条启发式：**启动后 N 秒（如 15s）内退出且无 crash-report** → 归为「启动失败」而不是「崩溃」，
文案与后续动作（去跑闸门/修复）不同。

---

## 已守住的部分（核对过，无需改）

| 检查点 | 位置 | 行为 |
|---|---|---|
| 版本 JSON 不存在 / 链为空 | `launch.js:324-327` | 抛错中止 |
| `mainClass` 缺失 | `launch.js:330` | 抛错中止 |
| 客户端 jar 缺失 | `launch.js:341-344` | 抛错中止 |
| 资源索引 `assets/indexes/<id>.json` 缺失 | `launch.js:365-367` | 抛错中止 |
| 找不到符合要求的 Java | `launch.js:465-473` | 抛错中止 |
| authlib-injector 下载失败 | `launch.js:281-293` | 抛错中止 |
| natives jar 解压失败 | `launch.js:129-131` | 抛错中止（tar 失败回退 PowerShell） |
| Java 授权校验先于一切文件检查 | `launch-spec.js:67-69` | 未登记 Java 直接拒绝 |
| 渲染进程未捕获异常 | `main.js:166-203` + `renderer.js:3333` | 落 appLog + 弹崩溃窗口（前提：渲染进程还活着） |
| GPU 子进程崩溃 | `main.js:209-225` | 记录标记 + 软件渲染重启，防循环 |

Java 安装侧（`mcdl/`）的完整性是**做得比 Node 侧好**的：`Http.download` 先写 `.part`、
校验大小与 SHA-1 后再原子 `move`（`Http.java:133-146/232-242`），`Installer.isComplete()`
在 `--verify` 下还会重算 SHA-1（`Installer.java:690-706`）。问题只在于：
Node 侧启动时**从不使用**这套校验（`redownload-assets` 是唯一带 `--verify` 的调用点，`main.js:3212`）。

---

## 建议实施顺序

1. **P0**：启动前完整性闸门 + 结构化失败清单 + UI 显式展示（第 1 节）。这一条直接消掉「闪退」的大部分来源。
2. **P0**：`render-process-gone` 三级恢复 + 零依赖 `recovery.html`（第 3 节）。
3. **P1**：spawn 失败语义修正（第 4 节）、Java 版本不匹配硬拦截（第 5 节）。
4. **P2**：authlib-injector 哈希校验与原子写入（第 2 节）、启动后 15s 内退出的「启动失败」归类（第 6 节）、
   `instances:maintenance` 增加 `repair`（按闸门清单定向重下）。**实际落地**：修复动作做成独立的
   `launcher:repair` IPC ＋ 实例管理菜单，没有加进 `instances:maintenance`（见 P0-1）。

---

# 已落地的修复

按上面的顺序实现，全部通过测试与一次真实应用回放验证。

## P0-1 启动前完整性闸门

| 文件 | 内容 |
|---|---|
| `electron/launch-preflight.js`（新增） | 校验 + 修复两个动作。`verifyRequiredFiles(files, { hashCheck })` 返回结构化结果（`missing` / `corrupt` / `optionalMissing`），`repairRequiredFiles` 按清单定向重下 |
| `electron/version-manifest.js` | `collectLibraries` 额外返回 `classpathArtifacts` / `nativeArtifacts`（带 sha1 / size / url），新增 `describeArtifact` |
| `electron/launch.js` | `buildLaunchPlan` 产出 `plan.requiredFiles`；新增 `verifyLaunchPlan` / `repairLaunchPlan`；`launchInstance` 在 **spawn 之前**过闸门，失败抛 `code = 'LAUNCH_PREFLIGHT_FAILED'` 并带 `details` |
| `electron/main.js` | 抽出 `resolveLaunchContext` / `resolveLaunchAccount` / `buildPlanForContext`（启动 / 预检 / 修复共用）；新增 IPC `launcher:preflight`、`launcher:repair`；`instances:launch-script` 同样过闸门 |
| `electron/renderer/renderer.js` + `index.html` | 新增 `dlgPreflight` 弹窗：逐条列出缺失项与原因，按钮「修复缺失文件」→ 修复成功后变成「重新启动」；实例管理菜单加「检查并修复缺失文件」 |
| `electron/preload.js` | 暴露 `checkLaunchFiles` / `repairLaunchFiles` |

顺带说明 `plan.warnings` 不再是死字段（第 1 节「更糟的是」那条）：首页大按钮与实例启动两处都读了
`result.warnings[0]` 并显示在启动提示行（`requestLaunch()` / 实例启动的 `.then`）——放行但仍有非致命
提示（例如版本 JSON 里有解析不出路径的库）时不会再被静默吞掉。

校验策略（`hashCheck`）：

- `'auto'`（**不设置时的默认**）：客户端 jar、资源索引、log4j 配置、authlib 始终算 SHA-1；
  依赖库 / natives 只查存在与非空。每次启动给几百 MB 的 libraries 算哈希会把启动拖到不可接受。
- 设置项 `verifyFiles` 只有 `null` / `true` / `false` 三种取值（`null` = 走 `'auto'`；`true` = 所有带
  `sha1` 的条目都比对；`false` = 只查存在与非空）。经核实实际是 `true` / `false` / `null`，
  没有把 `'auto'` 暴露成设置值（`launch.js` 的 `hashModeFromSettings()` 把 `null` 映射成 `'auto'`）。

修复策略：只处理清单里带 `url` 的条目；先整份读进内存 → 校验大小与 SHA-1 → 通过后才落盘。
经核实实际是 `writeFileAtomic()`（临时文件名 `.<文件名>.<pid>.<随机>.tmp` → `fsync` → `rename`），
**不是** `.mcdl-part-*`——这个前缀在仓库里不存在。因为校验在写盘之前完成，校验失败的文件不会出现在
目标路径。没有下载地址的条目（整合包手工塞的 jar）留在 `skipped` 里明说。

### 回放验证（真实应用 + CDP）

隔离数据目录 + 一个故意缺库的实例，点启动：

```
preflight = {"ok":false,"count":1,"checked":3,
  "failures":[{"kind":"library","label":"依赖库 com.example:missing-core:1.0","reason":"missing",
               "relative":"libraries\\com\\example\\missing-core\\1.0\\missing-core-1.0.jar"}]}
launch    = Error: 实例文件不完整，已中止启动（没有拉起 Java）。…
DOM       = dialogOpen=true, headline="已中止启动（没有拉起 Java）",
            items=["依赖库 com.example:missing-core:1.0 … 缺失"], repairLabel="修复缺失文件"
active    = []            ← 没有 Java 进程被拉起
```

点「修复缺失文件」（文件由本地 HTTP 服务提供、sha1 匹配）：

```
after repair = headline="缺失文件已修复，可以重新启动", items=[], repairLabel="重新启动"
recheck      = { ok: true, checked: 3 }
active       = []
```

## P0-2 渲染进程分层恢复

`electron/main.js`：

- `render-process-gone`：单次崩溃 → `reload()`；60 秒内第 3 次 → 判定崩溃循环，切恢复页。
  计数**不**在 `did-finish-load` 清零（否则「崩→重载成功→再崩」永远只算 1 次）。
- `did-fail-load`（主文档）：切恢复页；忽略 `-3`（自己取消的导航），恢复页自身失败只记日志，避免死循环。
- `unresponsive`：弹框给「继续等待 / 重新加载界面」。经核实：点「重新加载界面」实际调的是
  `forcefullyCrashRenderer()`，由 `render-process-gone` 的单次崩溃分支去 `reload()`，不是直接 `reload()`。
- 恢复页与主界面之间用 `recoveryPageActive` 互斥，`loadMainPage()` 同时清空计数。

`electron/renderer/recovery.html` + `recovery.js`（新增）：零依赖静态页（不加载主包），
三个出口「重新加载界面 / 重置工作区 / 导出诊断」，并把原因、时间、崩溃次数、错误码显示出来。
对应 IPC：`recovery:reload` / `recovery:reset-workspace` / `recovery:export-diagnostics`。
经核实：恢复页用的是 preload 暴露的三个白名单方法（`reloadFromRecovery` / `resetWorkspace` /
`exportDiagnostics`），没有为了 IPC 打开 `nodeIntegration`。

「导出诊断」的实际形态：把 appLog 尾部、GPU 标志、崩溃记录与环境信息写成**一个 txt**，
出口是系统保存对话框（默认文件名在桌面），不是静默打包到桌面。

「重置工作区」只清 Chromium 侧缓存与界面状态（`Cache` / `Code Cache` / `GPUCache` /
`Local Storage` / `Session Storage` / `Preferences` / `gpu-crash.json` 等），不动账号、实例、存档。

## P1

- **spawn 失败语义**：`launchInstance` 现在等 `'spawn'` 事件才算启动成功；`'error'`（ENOENT / EACCES）
  显式抛错并写进启动日志，不再出现「已启动 · PID -」然后什么都没发生。
- **Java 版本硬拦截**：`resolveJavaRuntime` 在两条路径上都拒绝低版本 Java
  （手动指定 → 报「需要 Java X，当前 Y」；自动探测 → 报「没有找到 Java X」），而不是打一行 warn 继续。

## P2

- **authlib-injector**：缓存文件先做最小体检（大小下限 + zip 魔数），不合格就删掉重下；
  下载后按 `latest.json.checksums` 验 sha256/sha1；写临时文件后 `rename`（走 `atomic-write.js`，含 fsync）。
  坏缓存不再永久命中。
- **启动失败归类**：15 秒内非 0 退出且无崩溃报告 → `earlyFailure: true`，游戏崩溃窗口换成
  「游戏没能启动」文案，并提示 Java 版本 / 文件完整性 / 参数三个方向。
- **定向修复入口**：实例管理「检查并修复缺失文件」走同一套闸门与修复逻辑。

## 测试

```
electron/tests/launch-preflight.test.js   18 项
  清单结构 / 缺失 / 空文件 / 大小不符 / 默认只哈希小文件 / 客户端 jar 哈希 /
  natives 缺失 / optional 缺失不失败 / 清单为空拒绝 / 闸门先于 spawn /
  闸门放行 / 修复成功 / 修复校验失败不留残留文件 / 无下载地址留 skipped
  （另有 4 项：启动进度按代码实际顺序、离线账号走完五步、闸门失败无 spawn 阶段、取消不 spawn）

electron/ 全量                            224 项全部通过
```

（经核实：`node --test --test-isolation=none` 实跑 `launch-preflight.test.js` 18 项、全量 224 项，
0 失败。原文写的 14 / 199 是加固过程中的旧数字。）

另外做了两次真实应用回放（都在独立的 `MCDL_USER_DATA` / `MCDL_GAME_DIR` 下进行）：

1. 正常启动：`window ready to show`，无异常；`launcher:preflight` / `launcher:repair` 均已注册。
2. 恢复页：`recovery.html?reason=crash-loop` 在 Electron 里实际加载，标题 / 元信息 / 三个按钮 /
   preload 桥接全部正常，「导出诊断」能走通 IPC，控制台零错误。

