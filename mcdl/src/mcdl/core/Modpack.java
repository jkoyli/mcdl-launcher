package mcdl.core;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Modrinth 整合包（.mrpack）安装器。
 *
 * <p>一个 .mrpack 里包含：</p>
 * <ul>
 *   <li>{@code modrinth.index.json}：游戏版本、加载器版本、每个 mod 的下载直链与哈希；</li>
 *   <li>{@code overrides/}、{@code client-overrides/}：配置、资源包等文件。</li>
 * </ul>
 *
 * <p>安装顺序：确保原版就位 → 安装加载器（Fabric/Quilt 用 meta JSON；Forge/NeoForge 调用官方安装器）
 * → 下载 mods → 解压 overrides → 生成 {@code versions/<实例>/<实例>.json}。</p>
 */
public final class Modpack {

    private Modpack() {
    }

    /** 安装结果。 */
    public static final class Result {
        public final String instanceName;
        public final Path instanceDir;
        public final String minecraftVersion;
        public final String loader;
        public final int fileCount;
        public int failedCount;

        Result(String instanceName, Path instanceDir, String minecraftVersion, String loader, int fileCount) {
            this.instanceName = instanceName;
            this.instanceDir = instanceDir;
            this.minecraftVersion = minecraftVersion;
            this.loader = loader;
            this.fileCount = fileCount;
        }
    }

    /**
     * 安装一个 Modrinth 整合包。
     *
     * @param mrpack         .mrpack 文件
     * @param mcDir          游戏目录（.minecraft）
     * @param requestedName  实例名，null/空则用整合包里的 name
     * @param jobs           下载并发
     */
    public static Result install(Path mrpack, Path mcDir, String requestedName, int jobs,
                                 String cfKey, Consumer<String> log) throws Exception {
        return install(mrpack, mcDir, requestedName, jobs, cfKey, new Cancel(), log);
    }

    /** 可取消版本；{@code cancel} 为 null 时视为不可取消。 */
    public static Result install(Path mrpack, Path mcDir, String requestedName, int jobs,
                                 String cfKey, Cancel cancel, Consumer<String> log) throws Exception {
        final Cancel token = cancel == null ? new Cancel() : cancel;
        try {
            return install0(mrpack, mcDir, requestedName, jobs, cfKey, token, log);
        } catch (Cancel.Cancelled e) {
            throw e;
        } catch (Exception e) {
            // 取消过程中被中断的任务会报各种 IOException，统一收敛成「已取消」
            if (token.isCancelled()) {
                throw new Cancel.Cancelled();
            }
            throw e;
        }
    }

    private static Result install0(Path mrpack, Path mcDir, String requestedName, int jobs,
                                   String cfKey, Cancel cancel, Consumer<String> log) throws Exception {
        cancel.throwIfCancelled();
        String kind = detectKind(mrpack);
        if ("curseforge".equals(kind)) {
            return installCurseForge(mrpack, mcDir, requestedName, jobs, cfKey, cancel, log);
        }
        Json.Value index;
        List<String> entries = new ArrayList<>();
        try (ZipFile zip = new ZipFile(mrpack.toFile())) {
            ZipEntry idx = zip.getEntry("modrinth.index.json");
            if (idx == null) {
                throw new IOException("不是 Modrinth 整合包：压缩包里没有 modrinth.index.json");
            }
            try (InputStream in = zip.getInputStream(idx)) {
                index = Json.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            }
            var en = zip.entries();
            while (en.hasMoreElements()) {
                entries.add(en.nextElement().getName());
            }
        }

        Json.Value deps = index.path("dependencies");
        String mcVersion = deps.opt("minecraft").asString("");
        if (mcVersion.isBlank()) {
            throw new IOException("整合包没有声明 Minecraft 版本（dependencies.minecraft）");
        }
        String loaderKey = null;
        String loaderVersion = "";
        for (String key : new String[]{"fabric-loader", "quilt-loader", "forge", "neoforge"}) {
            String v = deps.opt(key).asString("");
            if (!v.isBlank()) {
                loaderKey = key;
                loaderVersion = v;
                break;
            }
        }
        if (loaderKey == null) {
            loaderKey = "vanilla";
        }

        String baseName = requestedName;
        if (baseName == null || baseName.isBlank()) {
            baseName = index.opt("name").asString("");
        }
        if (baseName.isBlank()) {
            baseName = "Modrinth Pack";
        }
        String packSha = Http.sha1(mrpack);
        String name = resumableName(mcDir, sanitize(baseName), packSha);
        Path instanceDir = mcDir.resolve("versions").resolve(name);
        Files.createDirectories(instanceDir);

        log.accept("整合包：" + index.opt("name").asString(name) + "  版本 "
                + index.opt("versionId").asString("") + "  → 实例 " + name);
        log.accept("需要 Minecraft " + mcVersion + " + " + loaderKey
                + (loaderVersion.isBlank() ? "" : " " + loaderVersion));

        ImportState state = ImportState.load(instanceDir, packSha);
        state.mcVersion = mcVersion;
        state.loader = loaderKey + (loaderVersion.isBlank() ? "" : " " + loaderVersion);

        // 1) 原版
        cancel.throwIfCancelled();
        if (!state.vanillaDone) {
            Installer.Options vanilla = new Installer.Options();
            vanilla.dir = mcDir;
            vanilla.source = Sources.Source.AUTO;
            vanilla.jobs = Math.max(1, Math.min(32, jobs));
            vanilla.log = log;
            log.accept("== 步骤 1/4：确保原版 " + mcVersion + " 已安装 ==");
            Installer vanillaInstaller = new Installer(vanilla);
            cancel.onCancel(vanillaInstaller::cancel);
            vanillaInstaller.install(mcVersion);
            state.vanillaDone = true;
            state.save(instanceDir);
        } else {
            log.accept("== 步骤 1/4：原版已完成，跳过 ==");
        }

        // 2) 加载器
        cancel.throwIfCancelled();
        if (!state.loaderDone) {
            log.accept("== 步骤 2/4：安装加载器 ==");
            installLoader(loaderKey, loaderVersion, mcVersion, mcDir, instanceDir, name, jobs, cancel, log);
            state.loaderDone = true;
            state.save(instanceDir);
        } else {
            log.accept("== 步骤 2/4：加载器已完成，跳过 ==");
        }

        // 3) 下载 mods / 资源
        cancel.throwIfCancelled();
        log.accept("== 步骤 3/4：下载整合包文件 ==");
        int fileCount = downloadFiles(index, instanceDir, jobs, log, state, cancel);

        // 4) overrides
        cancel.throwIfCancelled();
        int overrides = 0;
        if (!state.overridesDone) {
            log.accept("== 步骤 4/4：解压 overrides ==");
            overrides = extractOverrides(mrpack, instanceDir, cancel, log);
            state.overridesDone = true;
            state.save(instanceDir);
        } else {
            log.accept("== 步骤 4/4：overrides 已完成，跳过 ==");
        }
        cancel.throwIfCancelled();
        state.done = state.failed.isEmpty();
        state.save(instanceDir);
        writeSummary(instanceDir, "Modrinth .mrpack", mrpack, mcVersion,
                loaderKey + (loaderVersion.isBlank() ? "" : " " + loaderVersion), state);
        log.accept("完成：实例 " + name + "（" + fileCount + " 个文件，" + overrides + " 个覆盖文件）");
        Result result = new Result(name, instanceDir, mcVersion,
                loaderKey + (loaderVersion.isBlank() ? "" : " " + loaderVersion), fileCount);
        result.failedCount = state.failed.size();
        return result;
    }

    //----------------------------------------------------------------------

    private static void installLoader(String loaderKey, String loaderVersion, String mcVersion,
                                      Path mcDir, Path instanceDir, String name, int jobs,
                                      Cancel cancel, Consumer<String> log) throws Exception {
        switch (loaderKey) {
            case "vanilla" -> writeThinJson(instanceDir, name, mcVersion);
            case "fabric-loader" -> installFromMeta(
                    "https://meta.fabricmc.net/v2/versions/loader/" + mcVersion + "/" + loaderVersion + "/profile/json",
                    mcDir, instanceDir, name, jobs, cancel, log);
            case "quilt-loader" -> installFromMeta(
                    "https://meta.quiltmc.org/v3/versions/loader/" + mcVersion + "/" + loaderVersion + "/profile/json",
                    mcDir, instanceDir, name, jobs, cancel, log);
            case "forge" -> installForgeLike(
                    "https://maven.minecraftforge.net/net/minecraftforge/forge/"
                            + mcVersion + "-" + loaderVersion + "/forge-" + mcVersion + "-" + loaderVersion + "-installer.jar",
                    mcVersion + "-forge-" + loaderVersion, mcVersion, mcDir, instanceDir, name, jobs, cancel, log);
            case "neoforge" -> installForgeLike(
                    "https://maven.neoforged.net/releases/net/neoforged/neoforge/" + loaderVersion
                            + "/neoforge-" + loaderVersion + "-installer.jar",
                    "neoforge-" + loaderVersion, mcVersion, mcDir, instanceDir, name, jobs, cancel, log);
            default -> throw new IOException("暂不支持的加载器：" + loaderKey);
        }
    }

    /** Fabric / Quilt：下载 meta 里的 profile JSON，改成我们的实例 id，并补齐库。 */
    private static void installFromMeta(String url, Path mcDir, Path instanceDir, String name,
                                        int jobs, Cancel cancel, Consumer<String> log) throws Exception {
        cancel.throwIfCancelled();
        String text = Http.getText(Sources.fileCandidates(Sources.Source.AUTO, url), log);
        Json.Value profile = Json.parse(text);
        profile.put("id", name);
        String inherits = profile.opt("inheritsFrom").asString("");
        if (!inherits.isBlank()) {
            profile.put("inheritsFrom", inherits);
        }
        Files.writeString(instanceDir.resolve(name + ".json"), profile.toPrettyString(), StandardCharsets.UTF_8);
        log.accept("已写入版本 JSON：" + name + ".json（继承 " + inherits + "）");

        List<Future<?>> futures = new ArrayList<>();
        ExecutorService pool = Executors.newFixedThreadPool(Math.max(1, Math.min(8, jobs)));
        cancel.onCancel(pool::shutdownNow);
        try {
            for (Json.Value lib : profile.path("libraries").asList()) {
                if (cancel.isCancelled()) {
                    break;
                }
                String libName = lib.opt("name").asString("");
                String base = lib.opt("url").asString("");
                if (libName.isBlank()) {
                    continue;
                }
                String path = VersionMeta.Library.mavenPath(libName);
                if (path == null) {
                    continue;
                }
                if (!base.isEmpty() && !base.endsWith("/")) {
                    base = base + "/";
                }
                String libUrl = base + path;
                String sha1 = lib.opt("sha1").asString("");
                long size = lib.opt("size").asLong(-1);
                Path dest = mcDir.resolve("libraries").resolve(path);
                futures.add(pool.submit(() -> {
                    if (cancel.isCancelled()) {
                        return null;
                    }
                    Http.download(dest, Sources.fileCandidates(Sources.Source.AUTO, libUrl),
                            sha1.isBlank() ? null : sha1, size, n -> {
                            }, path, log);
                    return null;
                }));
            }
            awaitAll(futures, cancel);
        } finally {
            if (cancel.isCancelled()) {
                pool.shutdownNow();
            } else {
                pool.shutdown();
            }
        }
    }

    /** Forge / NeoForge：下载官方安装器并运行（--installClient）。 */
    private static void installForgeLike(String installerUrl, String generatedId, String mcVersion,
                                         Path mcDir, Path instanceDir, String name, int jobs,
                                         Cancel cancel, Consumer<String> log) throws Exception {
        cancel.throwIfCancelled();
        Path tmp = LauncherDirs.newInstallerJar("installer");
        try {
            log.accept("下载加载器安装器…");
            // 交给 Loaders 统一处理：.sha1 强制校验（拿不到就换源/失败）+ zip 合法性校验 + 按候选地址换源，
            // 避免镜像返回 HTML 错误页时一路走到"运行安装器"才莫名其妙地失败
            Loaders.downloadInstaller(tmp, Sources.fileCandidates(Sources.Source.AUTO, installerUrl), log);
            cancel.throwIfCancelled();

            int javaMajor = requiredJavaMajor(mcDir, mcVersion);
            List<JavaFinder.JavaInfo> javas = JavaFinder.scan();
            JavaFinder.JavaInfo java = JavaFinder.best(javas, javaMajor);
            if (java == null) {
                throw new IOException("找不到可用的 Java 来运行加载器安装器");
            }
            log.accept("运行安装器：" + java.exe + " --installClient " + mcDir);
            // 执行前再确认一次：内容是能打开的 jar（哈希已在 downloadInstaller 里强制校验）
            Loaders.verifyInstallerJar(tmp, installerUrl);
            ProcessBuilder pb = new ProcessBuilder(java.exe.toString(), "-jar", tmp.toString(),
                    "--installClient", mcDir.toString());
            pb.directory(mcDir.toFile());
            pb.redirectErrorStream(true);
            Process process = pb.start();
            // 取消时直接杀掉安装器：否则它卡住会把导入线程永久挂在这里
            cancel.onCancel(process::destroyForcibly);
            Thread pump = new Thread(() -> {
                try (InputStream in = process.getInputStream()) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        String line = new String(buf, 0, n, StandardCharsets.UTF_8).trim();
                        if (!line.isEmpty()) {
                            log.accept("  [installer] " + line);
                        }
                    }
                } catch (IOException ignored) {
                    // 进程被杀或流关闭
                }
            }, "mcdl-installer-log");
            pump.setDaemon(true);
            pump.start();
            boolean finished = process.waitFor(30, TimeUnit.MINUTES);
            if (!finished) {
                process.destroyForcibly();
                throw new IOException("加载器安装器超过 30 分钟未完成，已终止");
            }
            pump.join(2000);
            cancel.throwIfCancelled();
            int code = process.exitValue();
            if (code != 0) {
                throw new IOException("加载器安装器退出码 " + code);
            }
            if (!Files.isDirectory(mcDir.resolve("versions").resolve(generatedId))) {
                throw new IOException("安装器没有生成版本 " + generatedId);
            }
            writeThinJson(instanceDir, name, generatedId);
        } finally {
            // 正常、异常、取消都清理；删不掉也不掩盖原始异常（下次启动会清扫过期残留）
            try {
                Files.deleteIfExists(tmp);
            } catch (IOException ignored) {
                // 忽略
            }
        }
    }

    private static int requiredJavaMajor(Path mcDir, String versionId) {
        try {
            Path json = mcDir.resolve("versions").resolve(versionId).resolve(versionId + ".json");
            if (Files.isRegularFile(json)) {
                return (int) Json.parse(json).path("javaVersion", "majorVersion").asLong(17);
            }
        } catch (Exception ignored) {
            // 读不到就按 17
        }
        return 17;
    }

    /** 写一个只含 id + inheritsFrom 的薄版本 JSON（原版 / Forge 安装器产物都适用）。 */
    private static void writeThinJson(Path instanceDir, String name, String inherits) throws IOException {
        Json.Value obj = Json.Value.obj();
        obj.put("id", name);
        obj.put("inheritsFrom", inherits);
        obj.put("type", "release");
        String now = java.time.OffsetDateTime.now().toString();
        obj.put("time", now);
        obj.put("releaseTime", now);
        Files.createDirectories(instanceDir);
        Files.writeString(instanceDir.resolve(name + ".json"), obj.toPrettyString(), StandardCharsets.UTF_8);
    }

    private static int downloadFiles(Json.Value index, Path instanceDir, int jobs,
                                     Consumer<String> log, ImportState state, Cancel cancel)
            throws Exception {
        List<Json.Value> tasks = new ArrayList<>();
        for (Json.Value f : index.path("files").asList()) {
            String env = f.path("env").opt("client").asString("required");
            if ("unsupported".equalsIgnoreCase(env)) {
                continue;
            }
            String path = f.opt("path").asString("");
            if (path.isBlank() || safeResolve(instanceDir, path) == null) {
                log.accept("  跳过非法路径：" + path);
                continue;
            }
            tasks.add(f);
        }
        if (tasks.isEmpty()) {
            return 0;
        }
        java.util.concurrent.atomic.AtomicInteger finished = new java.util.concurrent.atomic.AtomicInteger();
        ExecutorService pool = Executors.newFixedThreadPool(Math.max(1, Math.min(8, jobs)));
        cancel.onCancel(pool::shutdownNow);
        List<Future<?>> futures = new ArrayList<>();
        try {
            for (Json.Value f : tasks) {
                if (cancel.isCancelled()) {
                    break;
                }
                String path = f.opt("path").asString("");
                String sha1 = f.path("hashes").opt("sha1").asString("");
                long size = f.opt("fileSize").asLong(-1);
                List<String> urls = new ArrayList<>();
                for (Json.Value d : f.path("downloads").asList()) {
                    String u = d.asString("");
                    if (!u.isBlank()) {
                        urls.add(u);
                    }
                }
                if (urls.isEmpty()) {
                    continue;
                }
                Path dest = safeResolve(instanceDir, path);
                if (dest == null) {
                    continue;
                }
                if (state.isCompleted(path, dest) || (java.nio.file.Files.isRegularFile(dest)
                        && (sha1.isBlank() || sha1.equalsIgnoreCase(Http.sha1(dest))))) {
                    synchronized (state) {
                        state.completed.add(path);
                    }
                    log.accept("  跳过已完成 " + path);
                    continue;
                }
                futures.add(pool.submit(() -> {
                    if (cancel.isCancelled()) {
                        return null;
                    }
                    boolean ok = false;
                    try {
                        Http.download(dest, urls, sha1.isBlank() ? null : sha1, size, n -> {
                        }, path, null);
                        synchronized (state) {
                            state.completed.add(path);
                            state.failed.removeIf(x -> x.path.equals(path));
                        }
                        log.accept("  已下载 " + path);
                        ok = true;
                    } catch (Exception e) {
                        if (cancel.isCancelled()) {
                            // 取消导致的失败不记进失败清单
                            return null;
                        }
                        synchronized (state) {
                            state.failed.removeIf(x -> x.path.equals(path));
                            state.failed.add(new ImportState.Failed(path, path, sha1, size, urls,
                                    e.getMessage() == null ? "下载失败" : e.getMessage()));
                        }
                        log.accept("  失败 " + path + "：" + (e.getMessage() == null ? "" : e.getMessage()));
                    }
                    if (ok && finished.incrementAndGet() % 5 == 0) {
                        state.save(instanceDir);
                    }
                    return null;
                }));
            }
            awaitAll(futures, cancel);
        } finally {
            if (cancel.isCancelled()) {
                pool.shutdownNow();
            } else {
                pool.shutdown();
            }
        }
        state.save(instanceDir);
        return tasks.size();
    }

    private static int extractOverrides(Path mrpack, Path instanceDir, Cancel cancel,
                                        Consumer<String> log) throws IOException {
        int count = 0;
        int skipped = 0;
        try (ZipFile zip = new ZipFile(mrpack.toFile())) {
            var en = zip.entries();
            while (en.hasMoreElements()) {
                if (cancel.isCancelled()) {
                    throw new Cancel.Cancelled();
                }
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) {
                    continue;
                }
                String n = e.getName().replace('\\', '/');
                String rest = null;
                if (n.startsWith("overrides/")) {
                    rest = n.substring("overrides/".length());
                } else if (n.startsWith("client-overrides/")) {
                    rest = n.substring("client-overrides/".length());
                }
                if (rest == null || rest.isBlank()) {
                    continue;
                }
                Path dest = safeResolve(instanceDir, rest);
                if (dest == null) {
                    skipped++;
                    continue;
                }
                Files.createDirectories(dest.getParent());
                try (InputStream in = zip.getInputStream(e)) {
                    Files.copy(in, dest, StandardCopyOption.REPLACE_EXISTING);
                }
                count++;
            }
        }
        if (skipped > 0) {
            log.accept("  已跳过 " + skipped + " 个不安全的 overrides 条目（绝对路径或 ..）");
        }
        return count;
    }

    /** 同一个整合包（SHA-1 相同）复用原实例名，便于断点恢复；否则取不冲突的新名字。 */
    private static String resumableName(Path mcDir, String base, String packSha) {
        Path dir = mcDir.resolve("versions").resolve(base);
        if (java.nio.file.Files.isDirectory(dir)) {
            try {
                Json.Value s = Json.parse(dir.resolve(ImportState.FILE_NAME));
                if (packSha.equals(s.opt("packSha1").asString(""))) {
                    return base;
                }
            } catch (Exception ignored) {
                // 没有状态文件就当新实例
            }
        }
        return uniqueName(mcDir, base);
    }

    private static String uniqueName(Path mcDir, String base) {
        String name = base;
        int i = 2;
        while (Files.exists(mcDir.resolve("versions").resolve(name))) {
            name = base + " (" + i + ")";
            i++;
        }
        return name;
    }


    //----------------------------------------------------------------------
    // CurseForge
    //----------------------------------------------------------------------

    private static final String CF_API = "https://api.curseforge.com/v1";
    /** HMCL 使用的免 key 镜像（由镜像方注入 key）。 */
    private static final String CF_MIRROR = "https://mod.mcimirror.top/curseforge/v1";

    private static String detectKind(Path pack) throws IOException {
        try (ZipFile zip = new ZipFile(pack.toFile())) {
            var en = zip.entries();
            while (en.hasMoreElements()) {
                String n = en.nextElement().getName().replace('\\', '/').toLowerCase();
                if (n.endsWith("modrinth.index.json")) {
                    return "modrinth";
                }
                if (n.endsWith("manifest.json")) {
                    return "curseforge";
                }
            }
        }
        return "unknown";
    }

    private static Result installCurseForge(Path pack, Path mcDir, String requestedName, int jobs,
                                            String cfKey, Cancel cancel, Consumer<String> log) throws Exception {
        try {
            return installCurseForge0(pack, mcDir, requestedName, jobs, cfKey, cancel, log);
        } catch (Cancel.Cancelled e) {
            throw e;
        } catch (Exception e) {
            if (cancel.isCancelled()) {
                throw new Cancel.Cancelled();
            }
            throw e;
        }
    }

    private static Result installCurseForge0(Path pack, Path mcDir, String requestedName, int jobs,
                                             String cfKey, Cancel cancel, Consumer<String> log) throws Exception {
        cancel.throwIfCancelled();
        String manifestText;
        String prefix = "";
        try (ZipFile zip = new ZipFile(pack.toFile())) {
            ZipEntry entry = null;
            var en = zip.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                String n = e.getName().replace('\\', '/');
                if (n.equalsIgnoreCase("manifest.json") || n.toLowerCase().endsWith("/manifest.json")) {
                    entry = e;
                    prefix = n.substring(0, n.length() - "manifest.json".length());
                    break;
                }
            }
            if (entry == null) {
                throw new IOException("不是 CurseForge 整合包：缺少 manifest.json");
            }
            try (InputStream in = zip.getInputStream(entry)) {
                manifestText = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
        }

        Json.Value manifest = Json.parse(manifestText);
        String mcVersion = manifest.path("minecraft").opt("version").asString("");
        if (mcVersion.isBlank()) {
            throw new IOException("整合包没有声明 Minecraft 版本");
        }
        String loaderId = "";
        for (Json.Value ml : manifest.path("minecraft").path("modLoaders").asList()) {
            if (ml.opt("primary").asBoolean(false) || loaderId.isEmpty()) {
                loaderId = ml.opt("id").asString("");
            }
        }
        String loaderKey = "vanilla";
        String loaderVersion = "";
        if (!loaderId.isBlank()) {
            int dash = loaderId.indexOf('-');
            String ln = dash > 0 ? loaderId.substring(0, dash) : loaderId;
            loaderVersion = dash > 0 ? loaderId.substring(dash + 1) : "";
            loaderKey = switch (ln.toLowerCase()) {
                case "forge" -> "forge";
                case "neoforge" -> "neoforge";
                case "fabric" -> "fabric-loader";
                case "quilt" -> "quilt-loader";
                default -> throw new IOException("不支持的加载器：" + loaderId);
            };
        }

        String baseName = requestedName;
        if (baseName == null || baseName.isBlank()) {
            baseName = manifest.opt("name").asString("");
        }
        if (baseName.isBlank()) {
            baseName = "CurseForge Pack";
        }
        String packSha = Http.sha1(pack);
        String name = resumableName(mcDir, sanitize(baseName), packSha);
        Path instanceDir = mcDir.resolve("versions").resolve(name);
        log.accept("CurseForge 整合包：" + manifest.opt("name").asString(name) + " "
                + manifest.opt("version").asString("") + " → 实例 " + name);
        log.accept("需要 Minecraft " + mcVersion + " + " + (loaderId.isBlank() ? "vanilla" : loaderId));

        // 先确认 key 可用，避免装了一半才失败
        String key = resolveKey(cfKey);
        validateKey(key);
        Files.createDirectories(instanceDir);

        ImportState state = ImportState.load(instanceDir, packSha);
        state.mcVersion = mcVersion;
        state.loader = loaderKey + (loaderVersion.isBlank() ? "" : " " + loaderVersion);

        cancel.throwIfCancelled();
        if (!state.vanillaDone) {
            Installer.Options vanilla = new Installer.Options();
            vanilla.dir = mcDir;
            vanilla.source = Sources.Source.AUTO;
            vanilla.jobs = Math.max(1, Math.min(32, jobs));
            vanilla.log = log;
            log.accept("== 步骤 1/4：确保原版 " + mcVersion + " 已安装 ==");
            Installer vanillaInstaller = new Installer(vanilla);
            cancel.onCancel(vanillaInstaller::cancel);
            vanillaInstaller.install(mcVersion);
            state.vanillaDone = true;
            state.save(instanceDir);
        } else {
            log.accept("== 步骤 1/4：原版已完成，跳过 ==");
        }

        cancel.throwIfCancelled();
        if (!state.loaderDone) {
            log.accept("== 步骤 2/4：安装加载器 ==");
            installLoader(loaderKey, loaderVersion, mcVersion, mcDir, instanceDir, name, jobs, cancel, log);
            state.loaderDone = true;
            state.save(instanceDir);
        } else {
            log.accept("== 步骤 2/4：加载器已完成，跳过 ==");
        }

        cancel.throwIfCancelled();
        log.accept("== 步骤 3/4：通过 CurseForge API 解析并下载文件 ==");
        int count = downloadCurseForgeFiles(key, manifest, instanceDir, jobs, log, state, cancel);

        String overrides = manifest.opt("overrides").asString("overrides");
        if (overrides.isBlank()) {
            overrides = "overrides";
        }
        cancel.throwIfCancelled();
        int ov = 0;
        if (!state.overridesDone) {
            log.accept("== 步骤 4/4：解压 overrides ==");
            ov = extractPrefix(pack, prefix + overrides + "/", instanceDir, cancel, log);
            state.overridesDone = true;
            state.save(instanceDir);
        } else {
            log.accept("== 步骤 4/4：overrides 已完成，跳过 ==");
        }
        cancel.throwIfCancelled();
        state.done = state.failed.isEmpty();
        state.save(instanceDir);
        writeSummary(instanceDir, "CurseForge manifest", pack, mcVersion, state.loader, state);
        log.accept("完成：实例 " + name + "（" + count + " 个文件，" + ov + " 个覆盖文件）");
        Result result = new Result(name, instanceDir, mcVersion, state.loader, count);
        result.failedCount = state.failed.size();
        return result;
    }

    private static int downloadCurseForgeFiles(String key, Json.Value manifest, Path instanceDir,
                                               int jobs, Consumer<String> log, ImportState state,
                                               Cancel cancel)
            throws Exception {
        List<Json.Value> entries = manifest.path("files").asList();
        if (entries.isEmpty()) {
            return 0;
        }
        ExecutorService pool = Executors.newFixedThreadPool(Math.max(1, Math.min(8, jobs)));
        cancel.onCancel(pool::shutdownNow);
        List<Future<?>> futures = new ArrayList<>();
        List<String> manual = new ArrayList<>();
        java.util.concurrent.atomic.AtomicInteger count = new java.util.concurrent.atomic.AtomicInteger();
        try {
            for (Json.Value f : entries) {
                if (cancel.isCancelled()) {
                    break;
                }
                long pid = f.opt("projectID").asLong(0);
                long fid = f.opt("fileID").asLong(0);
                if (pid <= 0 || fid <= 0) {
                    continue;
                }
                futures.add(pool.submit(() -> {
                    String rel = null;
                    String sha1 = "";
                    long size = -1;
                    String url = "";
                    String fileName = "";
                    try {
                        if (cancel.isCancelled()) {
                            return null;
                        }
                        Json.Value data = cfGetFile(key, pid, fid);
                        url = data.opt("downloadUrl").asString("");
                        fileName = data.opt("fileName").asString("");
                        if (url.isBlank() || fileName.isBlank()) {
                            String label = fileName.isBlank() ? (pid + "/" + fid) : fileName;
                            synchronized (manual) {
                                manual.add(label);
                            }
                            synchronized (state) {
                                state.failed.add(new ImportState.Failed("mods/" + label, label,
                                        "", -1, List.of(), "作者关闭了 API 下载"));
                            }
                            log.accept("  跳过（作者禁止 API 下载）：" + label);
                            return null;
                        }
                        for (Json.Value h : data.path("hashes").asList()) {
                            if (h.opt("algo").asLong(0) == 1) {
                                sha1 = h.opt("value").asString("");
                            }
                        }
                        size = data.opt("fileLength").asLong(-1);
                        rel = "mods/" + safeFileName(fileName);
                        Path dest = instanceDir.resolve(rel);
                        if (state.isCompleted(rel, dest) || (java.nio.file.Files.isRegularFile(dest)
                                && (sha1.isBlank() || sha1.equalsIgnoreCase(Http.sha1(dest))))) {
                            synchronized (state) {
                                state.completed.add(rel);
                            }
                            log.accept("  跳过已完成 " + fileName);
                            return null;
                        }
                        Http.download(dest, List.of(url), sha1.isBlank() ? null : sha1, size, n -> {
                        }, fileName, null);
                        final String doneRel = rel;
                        synchronized (state) {
                            state.completed.add(doneRel);
                            state.failed.removeIf(x -> x.path.equals(doneRel));
                        }
                        count.incrementAndGet();
                        log.accept("  已下载 " + fileName);
                    } catch (Exception e) {
                        if (cancel.isCancelled()) {
                            // 取消导致的失败不记进失败清单
                            return null;
                        }
                        String label = fileName.isBlank() ? (pid + "/" + fid) : fileName;
                        String path = rel != null ? rel : "mods/" + label;
                        List<String> urls = url.isBlank() ? List.of() : List.of(url);
                        synchronized (state) {
                            state.failed.removeIf(x -> x.label.equals(label));
                            // 保存真实 path/sha1/size/url，「仅重试失败文件」才能重新下载
                            state.failed.add(new ImportState.Failed(path, label, sha1, size, urls,
                                    e.getMessage() == null ? "下载失败" : e.getMessage()));
                        }
                        log.accept("  失败：" + label + " — " + e.getMessage());
                        synchronized (manual) {
                            manual.add(label);
                        }
                    }
                    return null;
                }));
            }
            awaitAll(futures, cancel);
        } finally {
            if (cancel.isCancelled()) {
                pool.shutdownNow();
            } else {
                pool.shutdown();
            }
        }
        state.save(instanceDir);
        if (!manual.isEmpty()) {
            log.accept("注意：有 " + manual.size() + " 个文件未能自动下载，可在完成后点「仅重试失败文件」或手动补齐：");
            for (String m : manual) {
                log.accept("  - " + m);
            }
        }
        return count.get();
    }

    /** 用一个轻量请求确认 key 有效，避免每个文件都失败。 */
    private static String apiBase(String key) {
        return key == null || key.isBlank() ? CF_MIRROR : CF_API;
    }

    private static java.util.Map<String, String> apiHeaders(String key) {
        java.util.Map<String, String> headers = new java.util.LinkedHashMap<>();
        headers.put("Accept", "application/json");
        if (key != null && !key.isBlank()) {
            headers.put("x-api-key", key);
        }
        return headers;
    }

    private static void validateKey(String key) throws IOException {
        try {
            Http.getText(List.of(apiBase(key) + "/games?index=0&pageSize=1"), apiHeaders(key), null);
        } catch (IOException e) {
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (key == null || key.isBlank()) {
                throw new IOException("免 key 镜像当前不可用（" + msg + "）。\n"
                        + "请提供 CurseForge API key：https://console.curseforge.com/ → API Keys", e);
            }
            if (msg.contains("403") || msg.contains("401")) {
                throw new IOException("CurseForge API key 无效或已过期（" + msg + "）。"
                        + "请到 https://console.curseforge.com/ 重新创建。", e);
            }
            throw new IOException("无法连接 CurseForge API：" + msg, e);
        }
    }

    private static Json.Value cfGetFile(String key, long projectId, long fileId) throws IOException {
        String url = apiBase(key) + "/mods/" + projectId + "/files/" + fileId;
        String text = Http.getText(List.of(url), apiHeaders(key), null);
        return Json.parse(text).path("data");
    }

    /** 解析 CurseForge API key：参数 > 环境变量 > ~/.mcdl/curseforge.key。 */
    public static String resolveKey(String explicit) throws IOException {
        if (explicit != null && !explicit.isBlank()) {
            return explicit.trim();
        }
        for (String env : new String[]{"CF_API_KEY", "CURSEFORGE_API_KEY"}) {
            String v = System.getenv(env);
            if (v != null && !v.isBlank()) {
                return v.trim();
            }
        }
        for (Path file : new Path[]{keyFile(), appKeyFile()}) {
            if (file != null && Files.isRegularFile(file)) {
                String v = Files.readString(file, StandardCharsets.UTF_8).trim();
                if (!v.isBlank()) {
                    return v;
                }
            }
        }
        // 没有 key：先尝试 HMCL 同款免 key 镜像
        return "";
    }

    /** mcdl.jar / MCDL.exe 同级的 curseforge.key（分发时随包内置）。 */
    private static Path appKeyFile() {
        try {
            var src = Modpack.class.getProtectionDomain().getCodeSource();
            if (src != null && src.getLocation() != null) {
                Path p = Path.of(src.getLocation().toURI());
                Path dir = Files.isDirectory(p) ? p : p.getParent();
                if (dir != null) {
                    for (Path candidate : new Path[]{dir.resolve("curseforge.key"),
                            dir.getParent() == null ? null : dir.getParent().resolve("curseforge.key")}) {
                        if (candidate != null && Files.isRegularFile(candidate)) {
                            return candidate;
                        }
                    }
                }
            }
        } catch (Exception ignored) {
            // 取不到 code source 就忽略
        }
        return null;
    }

    public static Path keyFile() {
        return Path.of(System.getProperty("user.home"), ".mcdl", "curseforge.key");
    }

    public static void saveKey(String key) {
        try {
            Path file = keyFile();
            Files.createDirectories(file.getParent());
            Files.writeString(file, key.trim(), StandardCharsets.UTF_8);
        } catch (IOException ignored) {
            // 保存失败不影响本次使用
        }
    }

    private static int extractPrefix(Path zipPath, String prefix, Path instanceDir,
                                     Cancel cancel, Consumer<String> log) throws IOException {
        int count = 0;
        int skipped = 0;
        try (ZipFile zip = new ZipFile(zipPath.toFile())) {
            var en = zip.entries();
            while (en.hasMoreElements()) {
                if (cancel.isCancelled()) {
                    throw new Cancel.Cancelled();
                }
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) {
                    continue;
                }
                String n = e.getName().replace('\\', '/');
                if (!n.startsWith(prefix)) {
                    continue;
                }
                String rest = n.substring(prefix.length());
                if (rest.isBlank()) {
                    continue;
                }
                Path dest = safeResolve(instanceDir, rest);
                if (dest == null) {
                    skipped++;
                    continue;
                }
                Files.createDirectories(dest.getParent());
                try (InputStream in = zip.getInputStream(e)) {
                    Files.copy(in, dest, StandardCopyOption.REPLACE_EXISTING);
                }
                count++;
            }
        }
        if (skipped > 0) {
            log.accept("  已跳过 " + skipped + " 个不安全的覆盖文件条目（绝对路径或 ..）");
        }
        return count;
    }

    /**
     * 等所有任务结束；取消时取消剩余任务并立刻退出。
     *
     * <p>不能直接 {@code fut.get()}：取消会触发 {@code pool.shutdownNow()}，把还没开始的任务
     * 从队列里丢掉，这些 future 永远不会完成，get() 会永久阻塞。</p>
     */
    private static void awaitAll(List<Future<?>> futures, Cancel cancel) throws Exception {
        for (Future<?> f : futures) {
            while (true) {
                if (cancel.isCancelled()) {
                    for (Future<?> x : futures) {
                        x.cancel(true);
                    }
                    throw new Cancel.Cancelled();
                }
                try {
                    f.get(200, java.util.concurrent.TimeUnit.MILLISECONDS);
                    break;
                } catch (java.util.concurrent.TimeoutException e) {
                    // 继续等下一个 200ms，同时保持对取消的响应
                } catch (java.util.concurrent.CancellationException e) {
                    break;
                } catch (java.util.concurrent.ExecutionException e) {
                    if (cancel.isCancelled()) {
                        throw new Cancel.Cancelled();
                    }
                    throw e;
                }
            }
        }
    }

    /**
     * 把 zip 内的相对路径安全地解析到 {@code base} 之下；绝对路径、盘符、UNC 与 {@code ..}
     * 一律拒绝，返回 null。用于防 zip-slip。
     */
    static Path safeResolve(Path base, String relative) {
        if (relative == null || relative.isBlank()) {
            return null;
        }
        String rel = relative.replace('\\', '/').trim();
        if (rel.isEmpty() || rel.startsWith("/")) {
            // 以 / 开头的是绝对路径；// 开头是 UNC
            return null;
        }
        try {
            Path p = java.nio.file.Paths.get(rel);
            if (p.isAbsolute() || p.getRoot() != null) {
                return null;
            }
            for (Path part : p) {
                if ("..".equals(part.toString())) {
                    return null;
                }
            }
            Path root = base.toAbsolutePath().normalize();
            Path resolved = root.resolve(p).normalize();
            return resolved.startsWith(root) ? resolved : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String safeFileName(String name) {
        String s = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        return s.isBlank() ? "mod.jar" : s;
    }

    //----------------------------------------------------------------------
    // 预检 / 摘要 / key 验证
    //----------------------------------------------------------------------

    /** 整合包摘要（不安装，仅解析清单）。 */
    public static final class Summary {
        public String format = "";
        public String packName = "";
        public String packVersion = "";
        public String mcVersion = "";
        public String loader = "vanilla";
        public String loaderVersion = "";
        public int fileCount;
        /** -1 表示清单未提供体积（CurseForge）。 */
        public long downloadBytes = -1;
        public long overridesBytes;
        public String suggestedName = "";
    }

    /** 预检结果：磁盘空间、路径合法性。 */
    public static final class Preflight {
        public final Summary summary;
        public final long usableBytes;
        public final long requiredBytes;
        public final boolean blocked;
        public final java.util.List<String> warnings;

        Preflight(Summary summary, long usableBytes, long requiredBytes, boolean blocked,
                  java.util.List<String> warnings) {
            this.summary = summary;
            this.usableBytes = usableBytes;
            this.requiredBytes = requiredBytes;
            this.blocked = blocked;
            this.warnings = warnings;
        }
    }

    public static Summary preview(Path pack) throws IOException {
        String kind = detectKind(pack);
        return switch (kind) {
            case "modrinth" -> previewModrinth(pack);
            case "curseforge" -> previewCurseForge(pack);
            default -> throw new IOException("无法识别的整合包格式（缺少 modrinth.index.json / manifest.json）");
        };
    }

    private static Summary previewModrinth(Path pack) throws IOException {
        Summary s = new Summary();
        s.format = "Modrinth";
        try (ZipFile zip = new ZipFile(pack.toFile())) {
            ZipEntry idx = zip.getEntry("modrinth.index.json");
            if (idx == null) {
                throw new IOException("不是 Modrinth 整合包：缺少 modrinth.index.json");
            }
            Json.Value index;
            try (InputStream in = zip.getInputStream(idx)) {
                index = Json.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            }
            Json.Value deps = index.path("dependencies");
            s.mcVersion = deps.opt("minecraft").asString("");
            s.packName = index.opt("name").asString("");
            s.packVersion = index.opt("versionId").asString("");
            s.suggestedName = sanitize(s.packName.isBlank() ? "Modrinth Pack" : s.packName);
            String[] loaders = {"fabric-loader", "quilt-loader", "forge", "neoforge"};
            for (String key : loaders) {
                String v = deps.opt(key).asString("");
                if (!v.isBlank()) {
                    s.loader = key;
                    s.loaderVersion = v;
                    break;
                }
            }
            long total = 0;
            for (Json.Value f : index.path("files").asList()) {
                String env = f.path("env").opt("client").asString("required");
                if ("unsupported".equalsIgnoreCase(env)) {
                    continue;
                }
                s.fileCount++;
                long size = f.opt("fileSize").asLong(-1);
                if (size > 0) {
                    total += size;
                }
            }
            s.downloadBytes = total > 0 ? total : -1;
            s.overridesBytes = overridesBytes(zip, "overrides/", "client-overrides/");
        }
        return s;
    }

    private static Summary previewCurseForge(Path pack) throws IOException {
        Summary s = new Summary();
        s.format = "CurseForge";
        try (ZipFile zip = new ZipFile(pack.toFile())) {
            ZipEntry entry = null;
            String prefix = "";
            var en = zip.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                String n = e.getName().replace('\\', '/');
                if (n.equalsIgnoreCase("manifest.json") || n.toLowerCase().endsWith("/manifest.json")) {
                    entry = e;
                    prefix = n.substring(0, n.length() - "manifest.json".length());
                    break;
                }
            }
            if (entry == null) {
                throw new IOException("不是 CurseForge 整合包：缺少 manifest.json");
            }
            Json.Value manifest;
            try (InputStream in = zip.getInputStream(entry)) {
                manifest = Json.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            }
            s.mcVersion = manifest.path("minecraft").opt("version").asString("");
            s.packName = manifest.opt("name").asString("");
            s.packVersion = manifest.opt("version").asString("");
            s.suggestedName = sanitize(s.packName.isBlank() ? "CurseForge Pack" : s.packName);
            String loaderId = "";
            for (Json.Value ml : manifest.path("minecraft").path("modLoaders").asList()) {
                if (ml.opt("primary").asBoolean(false) || loaderId.isEmpty()) {
                    loaderId = ml.opt("id").asString("");
                }
            }
            if (!loaderId.isBlank()) {
                int dash = loaderId.indexOf('-');
                s.loader = dash > 0 ? loaderId.substring(0, dash) : loaderId;
                s.loaderVersion = dash > 0 ? loaderId.substring(dash + 1) : "";
            }
            s.fileCount = manifest.path("files").asList().size();
            s.downloadBytes = -1;
            s.overridesBytes = overridesBytes(zip, prefix + "overrides/");
        }
        return s;
    }

    private static long overridesBytes(ZipFile zip, String... prefixes) {
        long total = 0;
        var en = zip.entries();
        while (en.hasMoreElements()) {
            ZipEntry e = en.nextElement();
            if (e.isDirectory()) {
                continue;
            }
            String n = e.getName().replace('\\', '/');
            for (String prefix : prefixes) {
                if (n.startsWith(prefix)) {
                    total += e.getSize();
                    break;
                }
            }
        }
        return total;
    }

    /** 解析并预检：磁盘空间 > 1.5 倍预估体积、路径合法性。 */
    public static Preflight preflight(Path pack, Path mcDir) throws IOException {
        Summary s = preview(pack);
        java.util.List<String> warnings = new java.util.ArrayList<>();
        boolean blocked = false;

        String raw = mcDir.toString();
        if (raw.length() > 180) {
            warnings.add("目标路径过长（" + raw.length() + " 字符），部分启动器/工具可能无法处理");
        }
        if (raw.contains(" ")) {
            warnings.add("目标路径包含空格，通常可用，但个别旧工具会出问题");
        }
        boolean ascii = raw.chars().allMatch(c -> c < 128);
        if (!ascii) {
            warnings.add("目标路径包含非 ASCII 字符（中文等），通常可用，但部分组件兼容性较差");
        }

        boolean writable = false;
        try {
            java.nio.file.Files.createDirectories(mcDir);
            writable = java.nio.file.Files.isWritable(mcDir);
        } catch (Exception ignored) {
            writable = false;
        }
        long usable = -1;
        try {
            usable = java.nio.file.Files.getFileStore(mcDir).getUsableSpace();
        } catch (Exception ignored) {
            // 取不到就跳过磁盘检查
        }
        if (!writable) {
            blocked = true;
            warnings.add("目标目录不可写：" + mcDir);
        }

        long required = s.downloadBytes > 0 ? (long) (s.downloadBytes * 1.5) : -1;
        if (required > 0 && usable > 0 && usable < required) {
            blocked = true;
            warnings.add("磁盘空间不足：需要约 " + Installer.human(required) + "，剩余 " + Installer.human(usable));
        }
        return new Preflight(s, usable, required, blocked, warnings);
    }

    /** 验证 CurseForge API key，返回可直接展示的结果文本。 */
    public static String checkKey(String key) {
        if (key == null || key.isBlank()) {
            return "未填写 key";
        }
        try {
            Http.getText(List.of(CF_API + "/games?index=0&pageSize=1"), apiHeaders(key), null);
            return "有效";
        } catch (IOException e) {
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (msg.contains("429")) {
                return "被限流（HTTP 429），请稍后再试";
            }
            if (msg.contains("401") || msg.contains("403")) {
                return "无效或已过期（HTTP 401/403）";
            }
            return "无法连接：" + msg;
        }
    }

    /** 仅重试失败清单中的文件。 */
    public static Result retryFailed(Path pack, Path mcDir, String name, int jobs, String cfKey,
                                     Consumer<String> log) throws Exception {
        return retryFailed(pack, mcDir, name, jobs, cfKey, new Cancel(), log);
    }

    /** 可取消版本。 */
    public static Result retryFailed(Path pack, Path mcDir, String name, int jobs, String cfKey,
                                     Cancel cancel, Consumer<String> log) throws Exception {
        final Cancel token = cancel == null ? new Cancel() : cancel;
        try {
            return retryFailed0(pack, mcDir, name, jobs, cfKey, token, log);
        } catch (Cancel.Cancelled e) {
            throw e;
        } catch (Exception e) {
            if (token.isCancelled()) {
                throw new Cancel.Cancelled();
            }
            throw e;
        }
    }

    private static Result retryFailed0(Path pack, Path mcDir, String name, int jobs, String cfKey,
                                       Cancel cancel, Consumer<String> log) throws Exception {
        Path instanceDir = mcDir.resolve("versions").resolve(name);
        if (!java.nio.file.Files.isDirectory(instanceDir)) {
            throw new IOException("实例目录不存在：" + instanceDir);
        }
        ImportState state = ImportState.load(instanceDir, Http.sha1(pack));
        if (state.failed.isEmpty()) {
            log.accept("没有需要重试的失败文件。");
            return new Result(name, instanceDir, state.mcVersion, state.loader, state.completed.size());
        }
        log.accept("开始重试 " + state.failed.size() + " 个失败文件…");
        ExecutorService pool = Executors.newFixedThreadPool(Math.max(1, Math.min(8, jobs)));
        cancel.onCancel(pool::shutdownNow);
        List<Future<?>> futures = new ArrayList<>();
        List<ImportState.Failed> snapshot = new ArrayList<>(state.failed);
        java.util.concurrent.atomic.AtomicInteger ok = new java.util.concurrent.atomic.AtomicInteger();
        try {
            for (ImportState.Failed f : snapshot) {
                if (cancel.isCancelled()) {
                    break;
                }
                futures.add(pool.submit(() -> {
                    if (cancel.isCancelled()) {
                        return null;
                    }
                    if (f.urls.isEmpty()) {
                        log.accept("  跳过（无下载地址，需手动处理）：" + f.label);
                        return null;
                    }
                    Path dest = safeResolve(instanceDir, f.path);
                    if (dest == null) {
                        log.accept("  跳过非法路径：" + f.path);
                        return null;
                    }
                    try {
                        Http.download(dest, f.urls, f.sha1.isBlank() ? null : f.sha1, f.size, n -> {
                        }, f.label, null);
                        synchronized (state) {
                            state.completed.add(f.path);
                            state.failed.removeIf(x -> x.path.equals(f.path));
                        }
                        ok.incrementAndGet();
                        log.accept("  已补下 " + f.label);
                    } catch (Exception e) {
                        if (cancel.isCancelled()) {
                            return null;
                        }
                        synchronized (state) {
                            for (ImportState.Failed x : state.failed) {
                                if (x.path.equals(f.path)) {
                                    x.reason = e.getMessage() == null ? "下载失败" : e.getMessage();
                                }
                            }
                        }
                        log.accept("  仍失败 " + f.label);
                    }
                    return null;
                }));
            }
            awaitAll(futures, cancel);
        } finally {
            if (cancel.isCancelled()) {
                pool.shutdownNow();
            } else {
                pool.shutdown();
            }
        }
        state.done = state.failed.isEmpty();
        state.save(instanceDir);
        writeSummary(instanceDir, "重试失败文件", pack, state.mcVersion, state.loader, state);
        Result result = new Result(name, instanceDir, state.mcVersion, state.loader, state.completed.size());
        result.failedCount = state.failed.size();
        log.accept("重试结束：成功 " + ok.get() + "，仍失败 " + state.failed.size());
        return result;
    }

    /** 在实例目录写 install-summary.txt。 */
    private static void writeSummary(Path instanceDir, String source, Path pack, String mcVersion,
                                     String loader, ImportState state) {
        StringBuilder sb = new StringBuilder();
        sb.append("MCDL 安装摘要\n");
        sb.append("==============\n\n");
        sb.append("时间：").append(java.time.OffsetDateTime.now()).append('\n');
        sb.append("来源：").append(source).append('\n');
        sb.append("整合包文件：").append(pack.getFileName()).append('\n');
        try {
            sb.append("整合包 SHA-1：").append(Http.sha1(pack)).append('\n');
        } catch (IOException ignored) {
            sb.append("整合包 SHA-1：（读取失败）\n");
        }
        sb.append("Minecraft：").append(mcVersion).append('\n');
        sb.append("加载器：").append(loader).append('\n');
        sb.append("成功文件：").append(state.completed.size()).append('\n');
        sb.append("失败文件：").append(state.failed.size()).append('\n');
        sb.append("overrides：").append(state.overridesDone ? "已完成" : "未完成").append('\n');
        sb.append('\n').append("文件列表\n--------\n");
        for (String p : state.completed) {
            sb.append(p).append('\n');
        }
        if (!state.failed.isEmpty()) {
            sb.append('\n').append("失败列表\n--------\n");
            for (ImportState.Failed f : state.failed) {
                sb.append(f.label.isBlank() ? f.path : f.label);
                if (!f.reason.isBlank()) {
                    sb.append("  —  ").append(f.reason);
                }
                sb.append('\n');
            }
        }
        try {
            java.nio.file.Files.createDirectories(instanceDir);
            java.nio.file.Files.writeString(instanceDir.resolve("install-summary.txt"),
                    sb.toString(), StandardCharsets.UTF_8);
        } catch (IOException ignored) {
            // 摘要写不进去不影响安装
        }
    }
    private static String sanitize(String name) {
        String s = name == null ? "" : name.trim();
        s = s.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        // Windows 会忽略结尾的点；".."/"." 会变成上一级目录，必须挡掉
        while (s.endsWith(".")) {
            s = s.substring(0, s.length() - 1).trim();
        }
        if (s.isEmpty()) {
            s = "Modrinth Pack";
        }
        return s.length() > 60 ? s.substring(0, 60) : s;
    }
}
