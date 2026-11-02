# 更新记录

本文档记录每个版本的变更内容，按时间倒序排列。

## 1.0.8

- 新增 `--list-loaders <加载器> --mc <版本>`：列出 Forge / NeoForge / Fabric / Quilt 可用的构建（stdout 只有 JSON，进度走 stderr），Forge 带上官方推荐的 recommended / latest 标记。
- 新增 `--install-loader <加载器> --mc <版本> [--loader-version <v>] [--name <实例名>] [--dir <目录>]`：自动安装加载器。先确保原版就位，再生成 `versions/<实例名>/`，最后输出一段 JSON 安装结果供启动器解析。
- 加载器安装拆成三条路径：Fabric / Quilt 直接写 meta 的 profile JSON 并补库；Forge 1.12+ 与 NeoForge 走官方安装器的 `--installClient` 静默安装（自动补 `launcher_profiles.json`）；Forge 1.7.10 一类老安装器读安装器 zip 里的 `install_profile.json`，释放内嵌 universal jar 并写出 `versionInfo`。
- NeoForge 版本号按 HMCL 的规则反推 MC 版本（`21.1.9` → 1.21.1、`21.0.167` → 1.21、`20.4.x` → 1.20.4、`26.x` 年号方案），1.20.1 仍走 `net.neoforged:forge` 的 47.1.x。
- `Http` 增加 `getRawText`：maven 的 `maven-metadata.xml` 是 XML，不再被「返回的是 HTML 而不是 JSON」误判。

## 1.0.7

- 镜像源对话框未测速时显示「未测速」，不再把初始的 0 ms 显示成「无法连接」。
- CurseForge 失败项现在保存真实的 `mods/...` 路径、SHA-1、大小与下载地址，「仅重试失败文件」可以真正重新下载。
- 加载器安装器增加 30 分钟超时，超时会强制终止并报错，不再永久卡住。
- 修复「识别目录」会把手填 / 浏览选择的安装目录重置为第一项：现在只有启动时的自动识别会选第一项，手动点按钮会保留当前目录；命令行 `--gui --dir` 显式指定的目录也不会再被自动识别覆盖。
- 更新窗口副标题与状态栏文案：从「只下载原版」改为支持原版、Forge / NeoForge / Fabric / Quilt 与 Modrinth / CurseForge 整合包。
- 修复整合包导入状态的并发保存：`ImportState.save` / `isCompleted` 加锁，所有 `completed` / `failed` 修改统一加锁，临时文件改用唯一名，避免 `ConcurrentModificationException` 和截断 JSON。
- 版本号改为单一来源：`package.ps1` 从 `src/mcdl/Main.java` 的 `VERSION` 读取，打包时同步发布包内文档的版本号，不再单独维护。
- `首次运行说明.txt` 补充便携版文件清单、`启动.bat` 与 HIPS 拦截「打开文件夹」时的处理办法。
- 修复进度统计：资源索引的字节也计入总量，GUI/CLI 不再出现「437.6 KB / 34.2 KB」这种完成量大于总量的显示。
- 新增回归测试 `tests/PasteRegressionTest.java`（拖拽支持不得破坏文本框粘贴）与 `tests/FailureInstallTest.java`（故意让资源落盘失败，必须报真实原因且不卡住），用 `run-tests.bat` 一键运行。
- 文件 / 文件夹选择器改为随包发布的原生 `McdlDialog.exe`（`IFileOpenDialog`，资源管理器风格）：不依赖 PowerShell、`Add-Type` 或临时文件，`%TEMP%` 不可用时也不会再退回 Swing 的 `JFileChooser`；安装目录「浏览」是真正的文件夹选择器，「导入整合包」带 `.mrpack/.zip` 过滤。对话框以 MCDL 窗口为 owner，并主动置前，取消时不再误回退。
- helper 缺失或调用失败时才回退 PowerShell（`-EncodedCommand`，不落地脚本）与 `JFileChooser`；失败信息带异常类型并写入 `%USERPROFILE%\.mcdl\dialog-error.log`。
- 移除生产代码里的调试钩子（自动截图、`mcdl.debugUi`、`mcdl.smoke`、启动时置顶窗口），修复 MCDL 会遮挡其他程序窗口的问题；退出时清理对话框 PowerShell 进程，避免留下孤儿模态框。
- 修复拖拽支持覆盖文本框 `TransferHandler` 导致 Ctrl+V / Ctrl+X / Ctrl+C 失效（CF Key 无法粘贴）。
- 整合包导入与「仅重试失败文件」支持取消：新增 `Cancel` 协作式取消标记，取消按钮不再空转；关窗时先取消正在进行的任务再退出。
- 修复下载失败时报「安装失败：null」：`ExecutorCompletionService` 的 `CancellationException` 不再吞掉首个错误；同时修复失败后 `take()` 可能永久阻塞的问题（改为轮询 + 失败即停止等待）。
- 修复整合包 overrides 解压的 zip-slip：绝对路径、盘符、UNC 与 `..` 一律拒绝，且不再误杀 `config..json` 这类正常文件名；实例名拒绝 `.` / `..`。
- 修复「打开文件夹 / 打开目录」：只使用能确认结果的方式（原生 `SHOpenFolderAndSelectItems` / `ShellExecuteEx`、`Desktop.open`）；被 HIPS 拦截时打开应用内文件夹窗口并提示把 `MCDL.exe` / `McdlDialog.exe` / `java.exe` 加入信任区，不再误报「已打开」。
- 修复「打开文件夹 / 打开目录」：改用 `explorer.exe` 打开目录，避免 `Desktop.open` 在部分环境返回「拒绝访问」。
- 导入整合包与安装目录「浏览」都使用系统文件 / 文件夹选择器，失败时回退 `JFileChooser`。
- 镜像测速在无响应时显示「无法连接」，底部状态行汇总各镜像结果；全部不可达时明确提示。
- 版本列表获取失败时补充「无法连接网络或镜像」提示。

## 1.0.6

- 新增自定义镜像源：配置保存在 `%USERPROFILE%\.mcdl\sources.json`，支持添加、删除、置顶；版本清单、版本 JSON、客户端 jar、依赖库、资源对象的候选地址均按自定义镜像优先。
- 新增镜像健康度可视化：「镜像源」对话框列出官方、BMCLAPI 与自定义镜像；「测速」对每个镜像做 3 次探测，显示平均延迟与成功率，表头可排序。
- 新增 `Sources.customMirrors` / `addCustomMirror` / `removeCustomMirror` / `moveCustomMirrorTop` / `probeAll` 接口。

## 1.0.5

- 导入任务级断点恢复：实例目录写入 `.mcdl-import.json`，记录阶段（原版/加载器/文件/overrides）、已完成文件与失败清单；同一整合包（SHA-1 相同）重新导入时复用实例，跳过已完成阶段与文件。
- 失败项单独重试：导入结束存在失败文件时提示「仅重试失败文件」，`retryFailed` 只处理失败清单；无下载地址的失败项跳过。
- 实例目录生成 `install-summary.txt`：来源、时间、整合包 SHA-1、Minecraft 版本、加载器、成功/失败文件列表与失败原因。
- 命令行在导入结束后输出失败数量与摘要文件路径。

## 1.0.4

- 新增 CurseForge Key「验证」按钮：调用 `/v1/games` 轻量接口，区分有效、401/403 无效、429 限流与网络错误；验证通过后保存 key。
- 新增导入前预检卡片：解析整合包清单后展示来源格式、名称/版本、Minecraft 版本、加载器及版本、文件数、预计下载体积、overrides 体积、目标目录与所需空间，确认后才开始安装。
- 预检包含体积/时间粗估（按 300 KB/s）、磁盘剩余空间 1.5 倍检查（不足直接拦截）、路径长度/空格/非 ASCII/不可写警告。
- 新增 `Modpack.preview` / `preflight` / `checkKey` 接口。

## 1.0.3

- 新增窗口拖拽导入：将 `.mrpack` 或整合包 zip 拖入主窗口即触发导入，与「导入整合包…」按钮共用流程。
- 导入入口重构为 `beginImport(File)`，文件选择器与拖拽调用同一实现。
- 主窗口导入区新增拖拽操作提示文字。
- 版本列表合并本地 `versions` 目录扫描结果：本地实例以文件夹名显示，类型标记为「整合包 / 本地」。
- 已安装实例（含本地整合包）置顶显示，其余版本按发布时间倒序。
- 已安装实例行新增「打开文件夹」操作，点击直接打开该实例目录；选中本地实例时禁用下载按钮。
- 新增剪贴板链接检测：识别 Modrinth 项目页/版本页、CurseForge 项目页/文件页及 `.mrpack`/`.zip` 直链，主界面顶部显示「检测到链接，导入？」提示条，支持导入与忽略。
- 新增 `ModpackLink` 链接解析：Modrinth 走官方 API；CurseForge 经 cfwidget 获取文件名并按 CDN 规则拼接下载地址；解析后下载到临时目录并复用整合包导入流程。

## 1.0.2

- 新增 Modrinth 整合包（`.mrpack`）导入：解析 `modrinth.index.json`，安装原版与加载器，下载清单内文件，解压 `overrides/`、`client-overrides/`，生成版本 JSON。
- 新增 CurseForge 整合包（`manifest.json`）导入：解析 `minecraft.version`、`minecraft.modLoaders`、`files`，经 CurseForge API 解析下载地址与哈希，写入 `mods/`，解压 `overrides`。
- 加载器安装支持 Fabric、Quilt（meta profile 合并）与 Forge、NeoForge（调用官方 installer）。
- 新增 CurseForge API key 支持：`--cf-key` 参数、环境变量 `CF_API_KEY` / `CURSEFORGE_API_KEY`、用户级 `%USERPROFILE%\.mcdl\curseforge.key`、程序同级 `curseforge.key`。
- 新增免 key 镜像回退（`https://mod.mcimirror.top/curseforge`）；镜像不可用时返回明确错误。
- 调整 GUI 导入流程：新增 CF Key 输入框及说明文字；key 获取由导入前询问改为导入失败后提示，并自动重试一次。
- 打包脚本新增 `-CfKey` 参数，用于将 `curseforge.key` 放入发布包；新增 `首次运行说明.txt` 与 `CHANGELOG.md`。
- README 增加整合包导入、CurseForge key、Mark-of-the-Web 等内容。

## 1.0.1

- 新增 Java 自动发现：扫描 `JAVA_HOME`、`PATH`、Windows 注册表、常见安装目录、Mojang 运行时与 HMCL 运行时；支持 `release` 文件解析与 `java -version` 核实。
- 新增按版本匹配 Java：优先主版本一致，其次取高于要求的最小版本；`--list-java` 输出扫描结果。
- 新增游戏目录自动识别：PCL（注册表 `HKCU\Software\PCL`、`Setup.ini` 的 `LaunchFolderSelect`、程序同级 `.minecraft`）、HMCL（`user-game-directories.json`）、目录扫描与标记识别；支持 `--list-dirs`。
- 版本号由 1.0.0 更新为 1.0.1。
- 打包产物改为轻量版与便携版（jpackage app-image，内置 Java 17 运行时）。

## 1.0.0

- 首个版本。
- 版本清单获取与缓存，支持官方源、BMCLAPI 镜像与自动测速。
- 原版下载：版本 JSON、客户端 jar、依赖库、旧版 natives、资源索引、资源对象、log4j 配置。
- 下载可靠性：断点续传（`.part`）、SHA-1 校验、原子改名、并发下载、已存在文件跳过、镜像候选回退。
- 支持旧版 `virtual` / `map_to_resources` 资源索引。
- 提供 Swing 图形界面与命令行入口。
