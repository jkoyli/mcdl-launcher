package mcdl;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import mcdl.core.Installer;
import mcdl.core.Manifest;
import mcdl.core.Sources;
import mcdl.ui.MainWindow;

/**
 * 命令行入口。不带参数或带 --gui 时打开图形界面。
 */
public final class Main {

    private Main() {
    }

    /** 发布版本号。 */
    public static final String VERSION = "1.0.8";

    private static final String HELP = """
            MCDL — Minecraft 原版下载器（仿 PCL2 / HMCL 的下载逻辑）

            用法：
              java -jar mcdl.jar                     打开图形界面
              java -jar mcdl.jar --list [--type all] 列出可用版本
              java -jar mcdl.jar --install <版本id> [选项]
              java -jar mcdl.jar --dry-run <版本id>  只分析不下载

            选项：
              --dir <路径>        安装目录（不填则自动识别 PCL / HMCL 的目录）
              --source <源>       auto | official | bmclapi（默认 auto，自动测速）
              --jobs <N>          并发下载数（默认 16，范围 1~128）
              --verify            对已存在的文件做 SHA-1 校验（慢，但能修损坏文件）
              --force             忽略已存在文件，全部重新下载
              --no-assets         不下载资源文件（声音、语言、贴图等）
              --no-logging        不下载 log4j 配置
              --no-virtual        不处理旧版 virtual / map_to_resources 资源索引
              --type <类型>       --list 时过滤：release（默认）/ snapshot / old / all
              --list-java         扫描并核实本机所有 Java
              --list-dirs         识别 PCL / HMCL 使用的游戏目录
              --list-loaders <加载器>  列出某版本可用的加载器构建（fabric / quilt / forge / neoforge）
              --install-loader <加载器>  安装加载器（自动先装原版）
              --mc <版本>         配合 --list-loaders / --install-loader 指定 Minecraft 版本
              --loader-version <v> 指定加载器构建，不填取最新稳定版
              --install-pack <文件>  安装整合包（Modrinth .mrpack / CurseForge zip）
              --name <实例名>     实例名（整合包或加载器安装时使用）
              --cf-key <key>      CurseForge API key（也可用环境变量 CF_API_KEY）
              --java <路径>       指定 Java（java.exe 或 home 目录），不指定则自动匹配
              --limit-assets <N>  调试：只下载前 N 个资源对象
              --assets-only       调试：只下载资源对象，不下载 jar / 库
              --gui               强制打开图形界面
              --version           显示版本号
              --help              显示本帮助

            示例：
              java -jar mcdl.jar --install 1.20.1
              java -jar mcdl.jar --install 1.21.8 --dir D:\\MC --source bmclapi --jobs 32
            """;

    public static void main(String[] args) {
        try {
            int code = run(args);
            if (code != 0) {
                System.exit(code);
            }
        } catch (Throwable t) {
            System.err.println("错误：" + (t.getMessage() == null ? t.toString() : t.getMessage()));
            if (System.getenv("MCDL_DEBUG") != null) {
                t.printStackTrace();
            }
            System.exit(1);
        }
    }

    private static int run(String[] args) throws Exception {
        if (args.length == 0) {
            MainWindow.launch();
            return 0;
        }
        String command = null;
        String version = null;
        Path dir = defaultDir();
        boolean dirSet = false;
        String packFile = null;
        String packName = null;
        String cfKey = null;
        String loaderKey = null;
        String loaderVersion = null;
        String mcVersion = null;
        Sources.Source source = Sources.Source.AUTO;
        int jobs = 16;
        boolean verify = false;
        boolean force = false;
        boolean assets = true;
        boolean logging = true;
        boolean virtual = true;
        boolean dryRun = false;
        int limitAssets = 0;
        Path javaPath = null;
        boolean assetsOnly = false;
        String listType = "release";

        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            switch (a) {
                case "--version", "-V" -> {
                    System.out.println("MCDL " + VERSION);
                    return 0;
                }
                case "--help", "-h" -> {
                    System.out.println(HELP);
                    return 0;
                }
                case "--gui" -> command = "gui";
                case "--list-java" -> command = "list-java";
                case "--java" -> javaPath = Paths.get(need(args, ++i, "--java"));
                case "--list" -> command = "list";
                case "--install" -> {
                    command = "install";
                    version = need(args, ++i, "--install");
                }
                case "--dry-run" -> {
                    command = "dry-run";
                    version = need(args, ++i, "--dry-run");
                }
                case "--dir" -> {
                    dir = Paths.get(need(args, ++i, "--dir"));
                    dirSet = true;
                }
                case "--list-dirs" -> command = "list-dirs";
                case "--list-loaders" -> {
                    command = "list-loaders";
                    loaderKey = need(args, ++i, "--list-loaders");
                }
                case "--install-loader" -> {
                    command = "install-loader";
                    loaderKey = need(args, ++i, "--install-loader");
                }
                case "--mc" -> mcVersion = need(args, ++i, "--mc");
                case "--loader-version" -> loaderVersion = need(args, ++i, "--loader-version");
                case "--install-pack" -> {
                    command = "install-pack";
                    packFile = need(args, ++i, "--install-pack");
                }
                case "--name" -> packName = need(args, ++i, "--name");
                case "--cf-key" -> cfKey = need(args, ++i, "--cf-key");
                case "--source" -> source = Sources.Source.byKey(need(args, ++i, "--source"));
                case "--jobs" -> jobs = Integer.parseInt(need(args, ++i, "--jobs"));
                case "--verify" -> verify = true;
                case "--force" -> force = true;
                case "--no-assets" -> assets = false;
                case "--no-logging" -> logging = false;
                case "--no-virtual" -> virtual = false;
                case "--type" -> listType = need(args, ++i, "--type");
                case "--limit-assets" -> limitAssets = Integer.parseInt(need(args, ++i, "--limit-assets"));
                case "--assets-only" -> assetsOnly = true;
                default -> {
                    if (a.startsWith("-")) {
                        System.err.println("未知参数：" + a);
                        System.err.println(HELP);
                        return 2;
                    }
                    // 裸版本号视为 install
                    command = "install";
                    version = a;
                }
            }
        }

        if (command == null) {
            command = "gui";
        }
        if (!dirSet && ("install".equals(command) || "dry-run".equals(command) || "install-pack".equals(command))) {
            List<mcdl.core.LauncherDirs.DirInfo> dirs = mcdl.core.LauncherDirs.detect();
            if (!dirs.isEmpty()) {
                mcdl.core.LauncherDirs.DirInfo best = dirs.get(0);
                dir = best.dir;
                System.out.println("未指定 --dir，自动识别到：" + best.label());
            }
        }
        switch (command) {
            case "gui" -> {
                MainWindow.launch(dir, source);
                return 0;
            }
            case "list" -> {
                return list(source, listType);
            }
            case "list-java" -> {
                return listJava();
            }
            case "list-dirs" -> {
                return listDirs();
            }
            case "list-loaders" -> {
                return listLoaders(loaderKey, mcVersion, source);
            }
            case "install-loader" -> {
                if (!dirSet) {
                    List<mcdl.core.LauncherDirs.DirInfo> dirs = mcdl.core.LauncherDirs.detect();
                    if (!dirs.isEmpty()) {
                        dir = dirs.get(0).dir;
                        System.out.println("未指定 --dir，自动识别到：" + dirs.get(0).label());
                    }
                }
                return installLoader(loaderKey, mcVersion, loaderVersion, dir, packName, javaPath, jobs, source);
            }
            case "install-pack" -> {
                return installPack(packFile, dir, dirSet, packName, jobs, cfKey);
            }
            case "dry-run", "install" -> {
                return install(version, dir, source, jobs, verify, force, assets, logging, virtual,
                        limitAssets, assetsOnly, javaPath, "dry-run".equals(command));
            }
            default -> {
                return 2;
            }
        }
    }

    private static String need(String[] args, int i, String flag) {
        if (i >= args.length) {
            throw new IllegalArgumentException(flag + " 后面缺少参数值");
        }
        return args[i];
    }

    public static Path defaultDir() {
        String appData = System.getenv("APPDATA");
        if (appData != null && !appData.isEmpty()) {
            return Paths.get(appData, ".minecraft");
        }
        return Paths.get(System.getProperty("user.home"), ".minecraft");
    }

    private static int list(Sources.Source source, String type) throws IOException {
        System.out.println("正在获取版本清单… " + source.label);
        Manifest.Data data = Manifest.fetch(source, System.out::println);
        System.out.println("最新正式版：" + data.latestRelease + "    最新快照：" + data.latestSnapshot);
        System.out.println();
        String filter = type.toLowerCase(Locale.ROOT);
        int shown = 0;
        for (Manifest.RemoteVersion v : data.versions) {
            boolean ok = switch (filter) {
                case "all" -> true;
                case "old" -> v.type.startsWith("old");
                case "snapshot" -> "snapshot".equals(v.type);
                default -> "release".equals(v.type);
            };
            if (!ok) {
                continue;
            }
            System.out.printf("%-18s %-8s %s%n", v.id, v.typeLabel(), v.dateLabel());
            shown++;
        }
        System.out.println();
        System.out.println("共 " + shown + " 个版本。");
        return 0;
    }

    /** 安装 Modrinth 整合包。 */
    private static int installPack(String file, Path dir, boolean dirSet, String name, int jobs, String cfKey) throws Exception {
        Path pack = Paths.get(file);
        if (!Files.isRegularFile(pack)) {
            System.err.println("找不到整合包文件：" + pack);
            return 1;
        }
        if (!dirSet) {
            List<mcdl.core.LauncherDirs.DirInfo> dirs = mcdl.core.LauncherDirs.detect();
            if (!dirs.isEmpty()) {
                dir = dirs.get(0).dir;
                System.out.println("未指定 --dir，自动识别到：" + dirs.get(0).label());
            }
        }
        System.out.println("整合包：" + pack);
        System.out.println("游戏目录：" + dir);
        mcdl.core.Modpack.Result result = mcdl.core.Modpack.install(
                pack, dir, name, jobs, cfKey, s -> System.out.println("[MCDL] " + s));
        System.out.println();
        System.out.println("[完成] 实例 " + result.instanceName + " → " + result.instanceDir);
        if (result.failedCount > 0) {
            System.out.println("       失败文件 " + result.failedCount + " 个，详见 install-summary.txt");
        }
        System.out.println("       安装摘要：" + result.instanceDir.resolve("install-summary.txt"));
        System.out.println("       打开 PCL / HMCL 的版本列表即可看到并启动。");
        return 0;
    }

    /** 列出某个 Minecraft 版本可用的加载器构建，stdout 只输出 JSON。 */
    private static int listLoaders(String loader, String mcVersion, Sources.Source source) throws Exception {
        if (loader == null || loader.isBlank()) {
            System.err.println("错误：--list-loaders 需要一个加载器名（fabric / quilt / forge / neoforge）");
            return 2;
        }
        if (mcVersion == null || mcVersion.isBlank()) {
            System.err.println("错误：--list-loaders 需要 --mc <Minecraft 版本>");
            return 2;
        }
        String key = mcdl.core.Loaders.normalizeKey(loader);
        List<mcdl.core.Loaders.Entry> entries =
                mcdl.core.Loaders.list(key, mcVersion, source, s -> System.err.println("[MCDL] " + s));

        mcdl.core.Json.Value root = mcdl.core.Json.Value.obj();
        root.put("loader", key);
        root.put("label", mcdl.core.Loaders.labelOf(key));
        root.put("gameVersion", mcVersion);
        mcdl.core.Json.Value arr = mcdl.core.Json.Value.arr();
        for (mcdl.core.Loaders.Entry entry : entries) {
            mcdl.core.Json.Value row = mcdl.core.Json.Value.obj();
            row.put("version", entry.version);
            row.put("stable", entry.stable);
            row.put("note", entry.note);
            arr.add(row);
        }
        root.put("versions", arr);
        System.out.println(root.toPrettyString());
        return 0;
    }

    /** 自动安装加载器：先确保原版，再生成独立实例。 */
    private static int installLoader(String loader, String mcVersion, String loaderVersion, Path dir,
                                     String name, Path javaPath, int jobs, Sources.Source source)
            throws Exception {
        if (loader == null || loader.isBlank()) {
            System.err.println("错误：--install-loader 需要一个加载器名（fabric / quilt / forge / neoforge）");
            return 2;
        }
        if (mcVersion == null || mcVersion.isBlank()) {
            System.err.println("错误：--install-loader 需要 --mc <Minecraft 版本>");
            return 2;
        }
        String key = mcdl.core.Loaders.normalizeKey(loader);
        System.out.println("加载器：" + mcdl.core.Loaders.labelOf(key)
                + (loaderVersion == null || loaderVersion.isBlank() ? "（最新稳定版）" : " " + loaderVersion));
        System.out.println("游戏版本：" + mcVersion);
        System.out.println("游戏目录：" + dir);

        mcdl.core.Cancel cancel = new mcdl.core.Cancel();
        mcdl.core.Loaders.Result result = mcdl.core.Loaders.install(
                key, mcVersion, loaderVersion, dir, name, javaPath, jobs, source, cancel,
                s -> System.out.println("[MCDL] " + s));

        System.out.println();
        System.out.println("[完成] " + mcdl.core.Loaders.labelOf(result.loader) + " " + result.loaderVersion
                + " + Minecraft " + result.gameVersion);
        System.out.println("       实例：" + result.instanceId + " → " + result.instanceDir);

        // 给调用方（Electron）用的机器可读结果，最后一行固定是 JSON
        mcdl.core.Json.Value out = mcdl.core.Json.Value.obj();
        out.put("loader", result.loader);
        out.put("label", mcdl.core.Loaders.labelOf(result.loader));
        out.put("loaderVersion", result.loaderVersion);
        out.put("gameVersion", result.gameVersion);
        out.put("instanceId", result.instanceId);
        out.put("instanceDir", result.instanceDir.toAbsolutePath().toString());
        out.put("versionJson", result.versionJson);
        System.out.println(out.toPrettyString());
        return 0;
    }

    /** 列出识别到的 PCL / HMCL 游戏目录。 */
    private static int listDirs() {
        System.out.println("正在识别 PCL / HMCL 的游戏目录…");
        List<mcdl.core.LauncherDirs.DirInfo> dirs = mcdl.core.LauncherDirs.detect();
        mcdl.core.LauncherDirs.print(dirs, System.out::println);
        if (!dirs.isEmpty()) {
            System.out.println();
            System.out.println("默认使用：" + dirs.get(0).dir);
        }
        return 0;
    }

    /** 列出本机 Java，并逐个执行 -version 核实。 */
    private static int listJava() {
        System.out.println("正在扫描本机 Java…");
        List<mcdl.core.JavaFinder.JavaInfo> list = mcdl.core.JavaFinder.scan();
        for (mcdl.core.JavaFinder.JavaInfo info : list) {
            mcdl.core.JavaFinder.verify(info);
        }
        mcdl.core.JavaFinder.print(list, System.out::println);
        if (!list.isEmpty()) {
            System.out.println();
            System.out.println("提示：装完游戏后，启动器里请选择与该版本要求一致的 Java；"
                    + "常见对应关系见 README。");
        }
        return 0;
    }

    private static int install(String version, Path dir, Sources.Source source, int jobs,
                               boolean verify, boolean force, boolean assets, boolean logging,
                               boolean virtual, int limitAssets, boolean assetsOnly, Path javaPath, boolean dryRun)
            throws Exception {
        Installer.Options opt = new Installer.Options();
        opt.dir = dir;
        opt.source = source;
        opt.jobs = Math.max(1, Math.min(128, jobs));
        opt.verify = verify;
        opt.force = force;
        opt.assets = assets;
        opt.logging = logging;
        opt.virtualAssets = virtual;
        opt.dryRun = dryRun;
        opt.limitAssets = limitAssets;
        opt.assetsOnly = assetsOnly;
        opt.javaPath = javaPath;
        opt.log = s -> System.out.println("[MCDL] " + s);

        Installer installer = new Installer(opt);
        Thread printer = startPrinter(installer.stats(), dryRun);
        try {
            Installer.Stats stats = installer.install(version);
            if (printer != null) {
                printer.interrupt();
            }
            System.out.println();
            if (dryRun) {
                System.out.println("[完成] 分析完成（未下载任何文件）");
                return 0;
            }
            System.out.println("[完成] 已安装 " + version + " 到 " + dir.toAbsolutePath());
            System.out.println("  " + Installer.human(stats.downloadedBytes()) + " 下载 / "
                    + stats.doneFiles() + "/" + stats.totalFiles() + " 个文件 / "
                    + (stats.elapsedMillis() / 1000) + " 秒");
            System.out.println("  该版本可直接在 PCL2 / HMCL 的版本列表中看到并启动。");
            return 0;
        } catch (Exception e) {
            if (printer != null) {
                printer.interrupt();
            }
            System.out.println();
            System.err.println("[失败] 安装失败：" + e.getMessage());
            return 1;
        }
    }

    private static Thread startPrinter(Installer.Stats stats, boolean dryRun) {
        if (dryRun) {
            return null;
        }
        boolean console = System.console() != null;
        Thread t = new Thread(() -> {
            long lastPrint = 0L;
            try {
                while (!Thread.currentThread().isInterrupted()) {
                    Thread.sleep(400);
                    if (stats.finished()) {
                        break;
                    }
                    long now = System.currentTimeMillis();
                    // 输出被重定向到文件时不要狂刷 \r，改成每 2 秒一行
                    if (!console && now - lastPrint < 2000) {
                        continue;
                    }
                    lastPrint = now;
                    String line = String.format(Locale.ROOT,
                            "%3d%%  %s / %s  %s/s  剩余 %s  %s",
                            stats.percent(),
                            Installer.human(stats.doneBytes()),
                            Installer.human(stats.totalBytes()),
                            Installer.human((long) stats.rate()),
                            stats.etaLabel(),
                            truncate(stats.currentFile(), 40));
                    if (console) {
                        System.out.print("\r" + line + "        ");
                    } else {
                        System.out.println("[进度] " + line);
                    }
                }
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }, "mcdl-printer");
        t.setDaemon(true);
        t.start();
        return t;
    }

    private static String truncate(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }
}
