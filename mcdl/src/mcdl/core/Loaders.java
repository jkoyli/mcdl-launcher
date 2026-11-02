package mcdl.core;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 模组加载器的「自动安装」：版本列表 + 安装。
 *
 * <p>四个加载器走三条不同的路：</p>
 * <ul>
 *   <li>Fabric / Quilt：meta 服务器直接给出 profile JSON（已带 libraries 与 mainClass），
 *       写入版本目录并补齐库即可，不需要跑任何安装器。</li>
 *   <li>Forge 1.12+ / NeoForge：官方安装器支持 {@code --installClient <dir>} 静默安装，
 *       下载后交给安装器，再用一层薄 JSON 继承它生成的版本。</li>
 *   <li>Forge 1.7.10 一类老安装器：只有 Swing 界面、没有静默模式，改成像 HMCL 一样直接读
 *       安装器 zip 里的 {@code install_profile.json}：写出 {@code versionInfo}，把内嵌的
 *       universal jar 释放到 libraries，再补下载 versionInfo 里的库。</li>
 * </ul>
 *
 * <p>OptiFine / LiteLoader 需要额外的元数据来源（OptiFine 官网要浏览器 cookie，
 * LiteLoader 已于 1.12.2 停止更新），这里只做能力判断，不假装能装。</p>
 */
public final class Loaders {

    private Loaders() {
    }

    public static final String FABRIC = "fabric-loader";
    public static final String QUILT = "quilt-loader";
    public static final String FORGE = "forge";
    public static final String NEOFORGE = "neoforge";
    public static final String OPTIFINE = "optifine";
    public static final String LITELOADER = "liteloader";
    public static final String VANILLA = "vanilla";

    private static final Pattern XML_VERSION = Pattern.compile("<version>([^<]+)</version>");
    private static final Pattern DIGITS = Pattern.compile("\\d+");

    //------------------------------------------------------------------
    // 公共模型
    //------------------------------------------------------------------

    /** 一个可安装的加载器版本。 */
    public static final class Entry {
        public final String version;
        public final boolean stable;
        /** 界面用的补充说明，例如「推荐」或「1.20.1 可用」。 */
        public final String note;

        Entry(String version, boolean stable, String note) {
            this.version = version;
            this.stable = stable;
            this.note = note;
        }
    }

    /** 安装结果。 */
    public static final class Result {
        public final String loader;
        public final String loaderVersion;
        public final String gameVersion;
        public final String instanceId;
        public final Path instanceDir;
        public final String versionJson;

        Result(String loader, String loaderVersion, String gameVersion, String instanceId,
               Path instanceDir, String versionJson) {
            this.loader = loader;
            this.loaderVersion = loaderVersion;
            this.gameVersion = gameVersion;
            this.instanceId = instanceId;
            this.instanceDir = instanceDir;
            this.versionJson = versionJson;
        }
    }

    /** 参数里的加载器标识做一次归一化：Fabric / fabric / fabric-loader 都收。 */
    public static String normalizeKey(String raw) {
        String key = raw == null ? "" : raw.trim().toLowerCase(Locale.ROOT);
        return switch (key) {
            case "fabric", "fabric-loader", "fabricloader" -> FABRIC;
            case "quilt", "quilt-loader", "quiltloader" -> QUILT;
            case "forge", "minecraftforge" -> FORGE;
            case "neoforge", "neo-forge", "neoforged" -> NEOFORGE;
            case "optifine", "opti" -> OPTIFINE;
            case "liteloader", "lite" -> LITELOADER;
            case "vanilla", "原版", "" -> VANILLA;
            default -> key;
        };
    }

    public static String labelOf(String key) {
        return switch (normalizeKey(key)) {
            case FABRIC -> "Fabric";
            case QUILT -> "Quilt";
            case FORGE -> "Forge";
            case NEOFORGE -> "NeoForge";
            case OPTIFINE -> "OptiFine";
            case LITELOADER -> "LiteLoader";
            default -> "原版";
        };
    }

    /** 该加载器是否有自动安装实现。 */
    public static boolean supported(String key) {
        return switch (normalizeKey(key)) {
            case FABRIC, QUILT, FORGE, NEOFORGE -> true;
            default -> false;
        };
    }

    private static String unsupportedMessage(String key) {
        return switch (normalizeKey(key)) {
            case OPTIFINE -> "OptiFine 需要从官网手动下载安装器，暂未接入自动安装";
            case LITELOADER -> "LiteLoader 只支持到 1.12.2 且已停止更新，暂未接入自动安装";
            default -> "暂不支持的加载器：" + key;
        };
    }

    //------------------------------------------------------------------
    // 版本列表
    //------------------------------------------------------------------

    public static List<Entry> list(String key, String mcVersion, Sources.Source source,
                                   Consumer<String> log) throws IOException {
        String loader = normalizeKey(key);
        if (mcVersion == null || mcVersion.isBlank()) {
            throw new IOException("缺少 Minecraft 版本");
        }
        if (!supported(loader)) {
            throw new IOException(unsupportedMessage(loader));
        }
        return switch (loader) {
            case FABRIC -> listFabric(mcVersion, source, log);
            case QUILT -> listQuilt(mcVersion, source, log);
            case FORGE -> listForge(mcVersion, source, log);
            case NEOFORGE -> listNeoForge(mcVersion, source, log);
            default -> List.of();
        };
    }

    /** 4xx 说明这个加载器根本不支持该 MC 版本，换成能读懂的提示；其它错误原样抛出。 */
    private static IOException missingBuild(String loader, String mc, String hint, IOException cause) {
        String message = cause.getMessage() == null ? "" : cause.getMessage();
        if (message.contains("HTTP 4")) {
            return new IOException(loader + " 没有 " + mc + " 的构建（" + hint + "）", cause);
        }
        return new IOException(loader + " 版本列表获取失败：" + message, cause);
    }
    private static List<Entry> listFabric(String mc, Sources.Source source, Consumer<String> log)
            throws IOException {
        String url = "https://meta.fabricmc.net/v2/versions/loader/" + mc;
        Json.Value root;
        try {
            root = Json.parse(Http.getText(Sources.fileCandidates(source, url), log));
        } catch (IOException e) {
            throw missingBuild("Fabric", mc, "1.14 起才支持", e);
        }
        List<Entry> out = new ArrayList<>();
        while (root != null && root.isArray()) {
            for (Json.Value row : root.asList()) {
                String version = row.path("loader", "version").asString("");
                if (version.isEmpty()) {
                    continue;
                }
                boolean stable = row.path("loader", "stable").asBoolean(false);
                out.add(new Entry(version, stable, stable ? "稳定" : "测试"));
            }
            break;
        }
        if (out.isEmpty()) {
            throw new IOException("Fabric 没有返回 " + mc + " 的加载器版本");
        }
        out.sort((a, b) -> compareVersion(b.version, a.version));
        return out;
    }

    private static List<Entry> listQuilt(String mc, Sources.Source source, Consumer<String> log)
            throws IOException {
        String url = "https://meta.quiltmc.org/v3/versions/loader/" + mc;
        Json.Value root;
        try {
            root = Json.parse(Http.getText(Sources.fileCandidates(source, url), log));
        } catch (IOException e) {
            throw missingBuild("Quilt", mc, "1.18 起才支持", e);
        }
        List<Entry> out = new ArrayList<>();
        for (Json.Value row : root.asList()) {
            String version = row.path("loader", "version").asString("");
            if (version.isEmpty()) {
                continue;
            }
            boolean beta = version.toLowerCase(Locale.ROOT).contains("beta");
            out.add(new Entry(version, !beta, beta ? "测试" : "稳定"));
        }
        if (out.isEmpty()) {
            throw new IOException("Quilt 没有返回 " + mc + " 的加载器版本");
        }
        out.sort((a, b) -> compareVersion(b.version, a.version));
        return out;
    }

    /**
     * maven 地址的候选顺序：镜像优先。
     *
     * <p>Sources.fileCandidates 会按测速结果排官方 / 镜像，但 Forge、NeoForge 的 maven
     * 在国内经常直接连不上（要等 20 秒 connect timeout 才退化），而 BMCLAPI 的 /maven
     * 镜像一直是通的。所以加载器元数据和安装器都先走镜像，失败再回官方。</p>
     */
    private static List<String> mavenCandidates(Sources.Source source, String officialUrl) {
        String mirror = Sources.mapToBmcl(officialUrl);
        if (mirror == null || source == Sources.Source.OFFICIAL) {
            return List.of(officialUrl);
        }
        return Sources.dedupe(List.of(mirror, officialUrl));
    }
    private static List<Entry> listForge(String mc, Sources.Source source, Consumer<String> log)
            throws IOException {
        String metaUrl = "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";
        String xml = Http.getRawText(mavenCandidates(source, metaUrl), log);

        Set<String> versions = new LinkedHashSet<>();
        Matcher m = XML_VERSION.matcher(xml);
        while (m.find()) {
            String full = m.group(1).trim();
            String prefix = mc + "-";
            if (!full.startsWith(prefix)) {
                continue;
            }
            String rest = full.substring(prefix.length());
            // 老版本会写成 1.7.10-10.13.4.1614-1.7.10，尾巴上的 MC 版本要去掉
            if (rest.endsWith("-" + mc)) {
                rest = rest.substring(0, rest.length() - mc.length() - 1);
            }
            if (!rest.isEmpty()) {
                versions.add(rest);
            }
        }
        if (versions.isEmpty()) {
            throw new IOException("Forge 没有 " + mc + " 的构建（1.7.10 之后才有独立安装器）");
        }

        String recommended = fetchPromo(source, mc + "-recommended", log);
        String latest = fetchPromo(source, mc + "-latest", log);

        List<String> sorted = new ArrayList<>(versions);
        sorted.sort(Loaders::compareVersion);
        java.util.Collections.reverse(sorted);

        List<Entry> out = new ArrayList<>(sorted.size());
        for (String v : sorted) {
            boolean isRecommended = v.equals(recommended);
            boolean isLatest = v.equals(latest);
            String note = isRecommended ? "推荐" : isLatest ? "最新" : "";
            out.add(new Entry(v, isRecommended || isLatest, note));
        }
        return out;
    }

    private static String fetchPromo(Sources.Source source, String promoKey, Consumer<String> log) {
        try {
            String url = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
            Json.Value root = Json.parse(Http.getText(Sources.fileCandidates(source, url), log));
            return root.path("promos").opt(promoKey).asString("");
        } catch (Exception e) {
            // 拿不到推荐标记不影响列版本
            return "";
        }
    }

    private static List<Entry> listNeoForge(String mc, Sources.Source source, Consumer<String> log)
            throws IOException {
        // 1.20.1 的 NeoForge 还叫 net.neoforged:forge，构建号是 47.x
        if ("1.20.1".equals(mc)) {
            return listNeoForgeLegacy(source, log);
        }

        String metaUrl = "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";
        String xml = Http.getRawText(mavenCandidates(source, metaUrl), log);

        // NeoForge 的版本号蕴含 MC 版本：21.1.9 → 1.21.1，21.0.167 → 1.21，26.1.2.x → 26.1.2。
        // 不能简单按前缀匹配，否则 26.1.2.x 会被错当成 26.1。
        List<String> versions = new ArrayList<>();
        Matcher m = XML_VERSION.matcher(xml);
        while (m.find()) {
            String v = m.group(1).trim();
            if (v.isEmpty()) {
                continue;
            }
            if (mc.equals(mcVersionOfNeoForge(v))) {
                versions.add(v);
            }
        }
        if (versions.isEmpty()) {
            throw new IOException("NeoForge 没有 " + mc + " 的构建（需要 1.20.2+，1.20.1 请用 Forge 通道的 47.x）");
        }
        versions.sort(Loaders::compareVersion);
        java.util.Collections.reverse(versions);

        List<Entry> out = new ArrayList<>(versions.size());
        for (int i = 0; i < versions.size(); i++) {
            String v = versions.get(i);
            boolean stable = !v.toLowerCase(Locale.ROOT).contains("beta")
                    && !v.toLowerCase(Locale.ROOT).contains("alpha");
            out.add(new Entry(v, stable && i == 0, stable && i == 0 ? "最新" : ""));
        }
        return out;
    }

    /**
     * 从 NeoForge 版本号反推对应的 MC 版本（与 HMCL 的推导规则一致）：
     * 1.21.1 → {@code 21.1.9}，1.21 → {@code 21.0.167}，1.20.4 → {@code 20.4.237}；
     * 26.x 之后改成「年.季.补丁」，第三段为 0 时 MC 只到两段。
     */
    static String mcVersionOfNeoForge(String version) {
        int si1 = version.indexOf('.');
        if (si1 < 0) {
            return "";
        }
        int si2 = version.indexOf('.', si1 + 1);
        if (si2 < 0) {
            return "";
        }
        int major;
        int minor;
        try {
            major = Integer.parseInt(version.substring(0, si1));
            minor = Integer.parseInt(version.substring(si1 + 1, si2));
        } catch (NumberFormatException e) {
            return "";
        }
        if (major == 0) {
            // 0.x 线：0.1.0 之类，直接把中间段当 MC 版本
            return version.substring(si1 + 1, si2);
        }
        if (major >= 26) {
            int si3 = version.indexOf('.', si2 + 1);
            if (si3 < 0) {
                return "";
            }
            int patch;
            try {
                patch = Integer.parseInt(version.substring(si2 + 1, si3));
            } catch (NumberFormatException e) {
                return "";
            }
            String ver = patch == 0 ? version.substring(0, si2) : version.substring(0, si3);
            int plus = version.indexOf('+');
            return plus < 0 ? ver : ver + "-" + version.substring(plus + 1);
        }
        return minor == 0 ? "1." + version.substring(0, si1) : "1." + version.substring(0, si2);
    }

    /** 1.20.1 的 NeoForge：net.neoforged:forge，构建号 47.1.x。 */
    private static List<Entry> listNeoForgeLegacy(Sources.Source source, Consumer<String> log)
            throws IOException {
        String metaUrl = "https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml";
        String xml = Http.getRawText(mavenCandidates(source, metaUrl), log);
        List<String> versions = new ArrayList<>();
        Matcher m = XML_VERSION.matcher(xml);
        while (m.find()) {
            String v = m.group(1).trim();
            if (v.startsWith("47.1.")) {
                versions.add(v);
            }
        }
        if (versions.isEmpty()) {
            throw new IOException("NeoForge 没有 1.20.1 的 47.1.x 构建");
        }
        versions.sort(Loaders::compareVersion);
        java.util.Collections.reverse(versions);

        List<Entry> out = new ArrayList<>(versions.size());
        for (int i = 0; i < versions.size(); i++) {
            out.add(new Entry(versions.get(i), i == 0, i == 0 ? "最新" : ""));
        }
        return out;
    }

    //------------------------------------------------------------------
    // 安装
    //------------------------------------------------------------------

    /**
     * 安装加载器：先确保原版就位，再生成一个独立实例。
     *
     * @param loaderVersion 为空时自动取最新稳定版
     * @param instanceName  实例名（也作为 versions 下的目录名），留空时自动生成
     */
    public static Result install(String key, String mcVersion, String loaderVersion, Path mcDir,
                                 String instanceName, Path javaPath, int jobs, Sources.Source source,
                                 Cancel cancel, Consumer<String> log) throws Exception {
        String loader = normalizeKey(key);
        if (!supported(loader)) {
            throw new IOException(unsupportedMessage(loader));
        }
        if (mcVersion == null || mcVersion.isBlank()) {
            throw new IOException("缺少 Minecraft 版本");
        }
        if (cancel == null) {
            cancel = new Cancel();
        }
        if (log == null) {
            log = s -> {
            };
        }
        if (source == null) {
            source = Sources.Source.AUTO;
        }
        final int poolSize = Math.max(1, Math.min(32, jobs <= 0 ? 16 : jobs));

        // 1) 原版
        ensureVanilla(mcDir, mcVersion, source, poolSize, cancel, log);

        // 2) 加载器版本
        if (loaderVersion == null || loaderVersion.isBlank()) {
            List<Entry> entries = list(loader, mcVersion, source, log);
            loaderVersion = pickDefault(entries);
            log.accept("自动选择 " + labelOf(loader) + " " + loaderVersion);
        }

        // 3) 实例目录
        Path versionsDir = mcDir.resolve("versions");
        Files.createDirectories(versionsDir);
        String baseName = instanceName == null || instanceName.isBlank()
                ? mcVersion + " · " + labelOf(loader)
                : instanceName.trim();
        String instanceId = uniqueId(versionsDir, baseName);
        Path instanceDir = versionsDir.resolve(instanceId);
        Files.createDirectories(instanceDir);

        cancel.throwIfCancelled();
        String versionJson = switch (loader) {
            case FABRIC -> installFromMeta(
                    "https://meta.fabricmc.net/v2/versions/loader/" + mcVersion + "/" + loaderVersion + "/profile/json",
                    mcDir, instanceDir, instanceId, poolSize, source, cancel, log);
            case QUILT -> installFromMeta(
                    "https://meta.quiltmc.org/v3/versions/loader/" + mcVersion + "/" + loaderVersion + "/profile/json",
                    mcDir, instanceDir, instanceId, poolSize, source, cancel, log);
            case FORGE -> installForge(mcVersion, loaderVersion, mcDir, instanceDir, instanceId,
                    javaPath, poolSize, source, cancel, log);
            case NEOFORGE -> installNeoForge(mcVersion, loaderVersion, mcDir, instanceDir, instanceId,
                    javaPath, poolSize, source, cancel, log);
            default -> throw new IOException(unsupportedMessage(loader));
        };

        return new Result(loader, loaderVersion, mcVersion, instanceId, instanceDir, versionJson);
    }

    public static String pickDefault(List<Entry> entries) throws IOException {
        if (entries == null || entries.isEmpty()) {
            throw new IOException("没有可用的加载器版本");
        }
        for (Entry e : entries) {
            if (e.stable) {
                return e.version;
            }
        }
        return entries.get(0).version;
    }

    /** 原版没装就先装原版；已经装过就只做存在性检查。 */
    private static void ensureVanilla(Path mcDir, String mcVersion, Sources.Source source, int jobs,
                                      Cancel cancel, Consumer<String> log) throws Exception {
        Path json = mcDir.resolve("versions").resolve(mcVersion).resolve(mcVersion + ".json");
        if (Files.isRegularFile(json)) {
            log.accept("原版 " + mcVersion + " 已安装");
            return;
        }
        log.accept("先安装原版 " + mcVersion);
        Installer.Options opt = new Installer.Options();
        opt.dir = mcDir;
        opt.source = source;
        opt.jobs = jobs;
        opt.log = log;
        Installer installer = new Installer(opt);
        cancel.onCancel(installer::cancel);
        installer.install(mcVersion);
    }

    /** Fabric / Quilt：拿 meta 的 profile JSON，改成实例 id，再把库补齐。 */
    private static String installFromMeta(String url, Path mcDir, Path instanceDir, String instanceId,
                                          int jobs, Sources.Source source, Cancel cancel,
                                          Consumer<String> log) throws Exception {
        String text = Http.getText(Sources.fileCandidates(source, url), log);
        Json.Value profile = Json.parse(text);
        String inherits = profile.opt("inheritsFrom").asString("");
        if (inherits.isEmpty()) {
            throw new IOException("加载器元数据里没有 inheritsFrom，无法安装");
        }
        profile.put("id", instanceId);
        if (profile.opt("type").asString("").isEmpty()) {
            profile.put("type", "release");
        }
        Path jsonFile = instanceDir.resolve(instanceId + ".json");
        Files.writeString(jsonFile, profile.toPrettyString(), StandardCharsets.UTF_8);
        log.accept("已写入版本 JSON：" + instanceId + ".json（继承 " + inherits + "）");

        downloadLibraries(profile, mcDir, jobs, source, cancel, log);
        return jsonFile.toString();
    }

    private static String installForge(String mc, String loaderVersion, Path mcDir, Path instanceDir,
                                       String instanceId, Path javaPath, int jobs, Sources.Source source,
                                       Cancel cancel, Consumer<String> log) throws Exception {
        String base = "https://maven.minecraftforge.net/net/minecraftforge/forge/";
        String coords = mc + "-" + loaderVersion;
        List<String> urls = new ArrayList<>(2);
        urls.add(base + coords + "/forge-" + coords + "-installer.jar");
        // 1.7.10 时代的构建号自己就带 MC 版本：1.7.10-10.13.4.1614-1.7.10
        if (!loaderVersion.startsWith(mc + "-")) {
            String legacy = coords + "-" + mc;
            urls.add(base + legacy + "/forge-" + legacy + "-installer.jar");
        }
        return installForgeLike(urls, "forge", mc, loaderVersion, mcDir, instanceDir, instanceId,
                javaPath, jobs, source, cancel, log);
    }

    private static String installNeoForge(String mc, String loaderVersion, Path mcDir, Path instanceDir,
                                          String instanceId, Path javaPath, int jobs, Sources.Source source,
                                          Cancel cancel, Consumer<String> log) throws Exception {
        String installerUrl;
        String kind;
        if ("1.20.1".equals(mc)) {
            // net.neoforged:forge 的安装器叫 forge-<ver>-installer.jar
            installerUrl = "https://maven.neoforged.net/releases/net/neoforged/forge/" + loaderVersion
                    + "/forge-" + loaderVersion + "-installer.jar";
            kind = "forge";
        } else {
            installerUrl = "https://maven.neoforged.net/releases/net/neoforged/neoforge/" + loaderVersion
                    + "/neoforge-" + loaderVersion + "-installer.jar";
            kind = "neoforge";
        }
        return installForgeLike(List.of(installerUrl), kind, mc, loaderVersion, mcDir, instanceDir, instanceId,
                javaPath, jobs, source, cancel, log);
    }

    /**
     * Forge / NeoForge 安装器。
     *
     * <p>先看 install_profile.json 的结构决定走哪条路：
     * 有 {@code versionInfo} 的是 1.12.2 及更早的 Swing 安装器（没有静默模式），
     * 直接在本地解包；否则用 {@code --installClient} 跑官方安装器。</p>
     *
     * <p>安装器 jar 落在启动器缓存目录 {@code ~/.mcdl/cache/installers}（不是系统临时目录），
     * 并且无论成功、失败还是取消，{@code finally} 都会删掉。</p>
     */
    private static String installForgeLike(List<String> installerUrls, String kind, String mc, String loaderVersion,
                                           Path mcDir, Path instanceDir, String instanceId, Path javaPath,
                                           int jobs, Sources.Source source, Cancel cancel,
                                           Consumer<String> log) throws Exception {
        Path tmp = LauncherDirs.newInstallerJar(kind);
        try {
            List<String> candidates = new ArrayList<>();
            for (String url : installerUrls) {
                candidates.addAll(mavenCandidates(source, url));
            }
            log.accept("下载 " + kind + " 安装器 " + loaderVersion + " …");
            downloadInstaller(tmp, candidates, log);
            cancel.throwIfCancelled();

            Json.Value profile = readInstallProfile(tmp);
            if (profile == null) {
                throw new IOException("安装器里没有 install_profile.json，可能不是官方安装器");
            }

            String inheritedId;
            if (profile.get("versionInfo") != null && profile.path("versionInfo").isObject()) {
                inheritedId = installOldForge(tmp, profile, mcDir, jobs, source, cancel, log);
            } else {
                inheritedId = runInstaller(tmp, kind, mc, loaderVersion, mcDir, javaPath, cancel, log);
            }

            Path inheritedJson = mcDir.resolve("versions").resolve(inheritedId).resolve(inheritedId + ".json");
            if (!Files.isRegularFile(inheritedJson)) {
                throw new IOException("找不到安装器生成的版本 JSON：" + inheritedJson);
            }
            Path jsonFile = instanceDir.resolve(instanceId + ".json");
            Json.Value thin = Json.Value.obj();
            thin.put("id", instanceId);
            thin.put("inheritsFrom", inheritedId);
            thin.put("type", "release");
            Files.writeString(jsonFile, thin.toPrettyString(), StandardCharsets.UTF_8);
            log.accept("已写入版本 JSON：" + instanceId + ".json（继承 " + inheritedId + "）");
            return jsonFile.toString();
        } finally {
            // 正常、异常、取消都走这里；删不掉（例如安装器进程刚被杀还没释放句柄）也不掩盖
            // 原始异常，残留文件由下次启动的 pruneInstallerCache 兜底清理。
            try {
                Files.deleteIfExists(tmp);
            } catch (IOException ignored) {
                // 忽略
            }
        }
    }

    //------------------------------------------------------------------
    // 安装器下载 + 校验（Loaders 与 Modpack 共用）
    //------------------------------------------------------------------

    /**
     * 下载 Forge / NeoForge 安装器，并确认下载到的确实是一个 jar。
     *
     * <p>为什么不能只调 {@link Http#download}：安装器地址的期望哈希不在版本 JSON 里，
     * 只能自己去 maven 拿；而国内镜像偶尔会把 HTML 错误页或半截文件当成功返回。
     * 所以这里做三件事：</p>
     * <ol>
     *   <li>先读 maven 发布的 {@code <url>.sha1}（一行十六进制文本），<b>读不到就视为该地址
     *       失败</b>——安装器稍后要被执行，没有期望哈希就不能继续；</li>
     *   <li>逐个候选地址下载到临时文件，校验哈希后检查首 4 字节是 zip 头、且 {@link ZipFile} 能打开；</li>
     *   <li>某个地址的内容不合法就换下一个地址，全部失败才抛错。</li>
     * </ol>
     *
     * <p>注意这个方法自己按地址循环，所以传入的每个地址单独下载、单独校验：
     * 只有这样"镜像返回坏内容"时才能立刻换到官方源。</p>
     */
    public static void downloadInstaller(Path dest, List<String> candidates, Consumer<String> log)
            throws IOException {
        List<String> urls = Sources.dedupe(candidates);
        if (urls.isEmpty()) {
            throw new IOException("没有可用的加载器安装器下载地址");
        }
        // 目标文件由调用方创建（通常在启动器缓存目录），这里先写到同目录的 .dl 再改名，
        // 避免校验失败时把调用方的目标文件弄成半截。
        Path scratch = dest.resolveSibling(dest.getFileName() + ".dl");
        IOException last = null;
        for (String url : urls) {
            try {
                // 安装器会被 ProcessBuilder 执行，所以哈希校验是硬性前提：
                // 拿不到 .sha1 就把这个地址当作失败，换下一个候选（绝不"无哈希继续"）。
                String sha1 = requireMavenSha1(url);
                if (log != null) {
                    log.accept("  安装器 SHA-1：" + sha1);
                }
                deleteQuietly(scratch);
                Http.download(scratch, List.of(url), sha1, -1, n -> {
                }, "installer", log);
                verifyInstallerJar(scratch, url);
                try {
                    Files.move(scratch, dest, StandardCopyOption.REPLACE_EXISTING,
                            StandardCopyOption.ATOMIC_MOVE);
                } catch (IOException atomicFailed) {
                    Files.move(scratch, dest, StandardCopyOption.REPLACE_EXISTING);
                }
                return;
            } catch (IOException e) {
                last = e;
                if (log != null) {
                    log.accept("  安装器下载失败（" + shortUrl(url) + "）：" + e.getMessage());
                }
            } finally {
                deleteQuietly(scratch);
            }
        }
        throw new IOException("加载器安装器下载失败：" + (last == null ? "未知原因" : last.getMessage())
                + "（已尝试 " + urls.size() + " 个地址）", last);
    }

    /**
     * 取 maven 的 {@code <url>.sha1}，取不到直接抛错。
     *
     * <p>Forge / NeoForge 安装器下载后会被 {@code java -jar} 执行，没有期望哈希就等于
     * 放弃完整性校验，因此不允许降级。国内不代理 {@code .sha1} 的镜像会因此不可用，
     * 但调用方会按候选顺序继续尝试官方源。</p>
     */
    private static String requireMavenSha1(String url) throws IOException {
        String sha1 = probeMavenSha1(url);
        if (sha1 == null) {
            throw new IOException("无法校验安装器完整性：" + url
                    + " 未提供 .sha1。请换个下载源或稍后重试。");
        }
        return sha1;
    }

    /**
     * maven 对每个 artifact 都发布一份 {@code <url>.sha1}：通常只有一行十六进制文本
     * （少数仓库后面会跟一个空格 + 文件名）。
     *
     * <p>拿不到返回 {@code null}；调用方 {@link #requireMavenSha1(String)} 会据此判失败。
     * 这个方法只负责解析，不决定是否允许无哈希安装。</p>
     */
    private static String probeMavenSha1(String url) {
        try {
            String text = Http.getRawText(List.of(url + ".sha1"), null);
            if (text == null || text.isBlank()) {
                return null;
            }
            // 只看第一行，避免把带 HTML 的错误页（多行）误当哈希
            String first = text.strip().split("\\R", 2)[0].trim();
            String hex = first.split("\\s+", 2)[0];
            if (hex.length() == 40 && hex.matches("[0-9a-fA-F]{40}")) {
                return hex.toLowerCase(Locale.ROOT);
            }
        } catch (Exception ignored) {
            // 404 / 超时 / 返回 HTML：没有哈希可用，按无哈希流程继续
        }
        return null;
    }

    /**
     * 安装器必须是能打开的 zip。镜像劫持、错误页、截断的 jar 都会在这里被拦住，
     * 而不是等到 readInstallProfile 才报"没有 install_profile.json"。
     */
    static void verifyInstallerJar(Path file, String source) throws IOException {
        if (!Files.isRegularFile(file) || Files.size(file) < 4) {
            throw new IOException(notAJarMessage(source));
        }
        byte[] head = new byte[4];
        try (InputStream in = Files.newInputStream(file)) {
            if (in.readNBytes(head, 0, 4) < 4) {
                throw new IOException(notAJarMessage(source));
            }
        }
        boolean localHeader = head[0] == 'P' && head[1] == 'K' && head[2] == 3 && head[3] == 4;
        boolean emptyZip = head[0] == 'P' && head[1] == 'K' && head[2] == 5 && head[3] == 6;
        if (!localHeader && !emptyZip) {
            throw new IOException(notAJarMessage(source));
        }
        int entries;
        try (ZipFile zip = new ZipFile(file.toFile())) {
            entries = zip.size();
        } catch (IOException e) {
            throw new IOException(notAJarMessage(source), e);
        }
        if (entries == 0) {
            throw new IOException(notAJarMessage(source));
        }
    }

    private static String notAJarMessage(String source) {
        return "安装器下载内容不是有效的 jar（来源：" + source + " 或镜像）。"
                + "请换下载源重试，或检查网络代理是否劫持了下载。";
    }

    private static void deleteQuietly(Path file) {
        try {
            Files.deleteIfExists(file);
            // Http.download 的断点文件，换源时一起清掉，别把坏内容续传到下一个地址
            Files.deleteIfExists(file.resolveSibling(file.getFileName() + ".part"));
        } catch (IOException ignored) {
            // 临时文件删不掉不影响结果
        }
    }

    /** 日志里用的短地址：host + 截断后的 path。 */
    private static String shortUrl(String url) {
        try {
            java.net.URI u = java.net.URI.create(url);
            String path = u.getPath();
            if (path != null && path.length() > 48) {
                path = "..." + path.substring(path.length() - 45);
            }
            return u.getHost() + path;
        } catch (RuntimeException e) {
            return url;
        }
    }

    private static Json.Value readInstallProfile(Path installer) throws IOException {
        try (ZipFile zip = new ZipFile(installer.toFile())) {
            ZipEntry entry = zip.getEntry("install_profile.json");
            if (entry == null) {
                return null;
            }
            try (InputStream in = zip.getInputStream(entry)) {
                return Json.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8));
            }
        }
    }

    /** 1.12.2 及更早：解包 versionInfo + 内嵌 universal jar，不运行安装器。 */
    private static String installOldForge(Path installer, Json.Value profile, Path mcDir, int jobs,
                                          Sources.Source source, Cancel cancel, Consumer<String> log)
            throws Exception {
        Json.Value versionInfo = profile.path("versionInfo");
        String id = versionInfo.opt("id").asString("");
        if (id.isEmpty()) {
            throw new IOException("安装器里的 versionInfo 没有 id");
        }

        // 内嵌的 universal jar：install.filePath（zip 内路径）→ install.path（maven 坐标）
        Json.Value install = profile.get("install");
        if (install != null && install.isObject()) {
            String filePath = install.opt("filePath").asString("");
            String maven = install.opt("path").asString("");
            if (!filePath.isEmpty() && !maven.isEmpty()) {
                String libPath = VersionMeta.Library.mavenPath(maven);
                if (libPath != null) {
                    Path dest = mcDir.resolve("libraries").resolve(libPath);
                    Files.createDirectories(dest.getParent());
                    try (ZipFile zip = new ZipFile(installer.toFile());
                         InputStream in = zip.getInputStream(zip.getEntry(filePath))) {
                        Files.copy(in, dest, StandardCopyOption.REPLACE_EXISTING);
                    }
                    log.accept("已释放 universal jar：" + libPath);
                }
            }
        }

        Path versionDir = mcDir.resolve("versions").resolve(id);
        Files.createDirectories(versionDir);
        Files.writeString(versionDir.resolve(id + ".json"), versionInfo.toPrettyString(), StandardCharsets.UTF_8);
        log.accept("已写入安装器自带的版本 JSON：" + id + ".json");

        downloadLibraries(versionInfo, mcDir, jobs, source, cancel, log);
        return id;
    }

    /** 1.13+ / NeoForge：跑官方安装器，返回它生成的版本 id。 */
    private static String runInstaller(Path installer, String kind, String mc, String loaderVersion,
                                       Path mcDir, Path javaPath, Cancel cancel, Consumer<String> log)
            throws Exception {
        ensureLauncherProfiles(mcDir);

        int javaMajor = requiredJavaMajor(mcDir, mc);
        Path java = javaPath;
        if (java == null || !Files.isRegularFile(java)) {
            List<JavaFinder.JavaInfo> javas = JavaFinder.scan();
            JavaFinder.JavaInfo best = JavaFinder.best(javas, javaMajor);
            if (best == null) {
                throw new IOException("找不到可用的 Java 来运行加载器安装器（需要 Java " + javaMajor + "+）");
            }
            java = best.exe;
        }

        Set<String> before = listVersionDirs(mcDir);
        // 执行前再校验一次：安装器来自网络，必须先确认哈希（在 downloadInstaller 里）
        // 且文件确实是可打开的 jar，任何一项不满足都直接抛错，绝不启动进程。
        verifyInstallerJar(installer, installer.toString());
        log.accept("运行安装器：" + java + " -jar 安装器 --installClient " + mcDir);
        ProcessBuilder pb = new ProcessBuilder(java.toString(), "-Dfile.encoding=UTF-8", "-jar",
                installer.toString(), "--installClient", mcDir.toString());
        pb.directory(mcDir.toFile());
        pb.redirectErrorStream(true);
        Process process = pb.start();
        cancel.onCancel(process::destroyForcibly);

        Thread pump = new Thread(() -> {
            try (InputStream in = process.getInputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    for (String line : new String(buf, 0, n, StandardCharsets.UTF_8).split("\\R")) {
                        String trimmed = line.trim();
                        if (!trimmed.isEmpty()) {
                            log.accept("  [installer] " + trimmed);
                        }
                    }
                }
            } catch (IOException ignored) {
                // 进程被杀或流关闭
            }
        }, "mcdl-" + kind + "-installer-log");
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

        String generated = findGeneratedVersion(mcDir, before, kind, mc, loaderVersion);
        if (code != 0) {
            String hint = generated == null
                    ? "。该版本的安装器可能不支持 --installClient 静默安装，请改用 1.13 及以上的 Forge"
                    : "";
            throw new IOException("加载器安装器退出码 " + code + hint);
        }
        if (generated == null) {
            throw new IOException("安装器没有生成新的版本目录（预期包含 " + kind + "）");
        }
        log.accept("安装器已生成版本：" + generated);
        return generated;
    }

    /** 官方安装器会检查 launcher_profiles.json，缺了会直接报错。 */
    private static void ensureLauncherProfiles(Path mcDir) throws IOException {
        Path file = mcDir.resolve("launcher_profiles.json");
        if (Files.isRegularFile(file)) {
            return;
        }
        Json.Value root = Json.Value.obj();
        root.put("profiles", Json.Value.obj());
        root.put("settings", Json.Value.obj());
        root.put("version", 3L);
        Files.writeString(file, root.toPrettyString(), StandardCharsets.UTF_8);
    }

    private static Set<String> listVersionDirs(Path mcDir) {
        Set<String> out = new LinkedHashSet<>();
        Path versions = mcDir.resolve("versions");
        if (!Files.isDirectory(versions)) {
            return out;
        }
        try (var stream = Files.list(versions)) {
            stream.filter(Files::isDirectory).forEach(p -> out.add(p.getFileName().toString()));
        } catch (IOException ignored) {
            // 列不出来就当没有
        }
        return out;
    }

    /**
     * 安装器生成的目录名各版本不完全一致（1.20.1-forge-47.2.0 / neoforge-21.1.66 /
     * 1.12.2-forge1.12.2-14.23.5.2860），所以用「新增目录 + 名字里含 kind」来判断，
     * 判断不出来时再退回按命名规则推算。
     */
    private static String findGeneratedVersion(Path mcDir, Set<String> before, String kind,
                                               String mc, String loaderVersion) {
        Set<String> after = listVersionDirs(mcDir);
        String fallback = null;
        for (String id : after) {
            String lower = id.toLowerCase(Locale.ROOT);
            if (!before.contains(id) && lower.contains(kind)) {
                return id;
            }
            if (fallback == null && lower.contains(kind) && lower.contains(loaderVersion.toLowerCase(Locale.ROOT))) {
                fallback = id;
            }
        }
        if (fallback != null) {
            return fallback;
        }
        // 命名规则兜底
        String guess = "forge".equals(kind) ? mc + "-forge-" + loaderVersion : "neoforge-" + loaderVersion;
        if (after.contains(guess)) {
            return guess;
        }
        return null;
    }

    private static int requiredJavaMajor(Path mcDir, String versionId) {
        try {
            Path json = mcDir.resolve("versions").resolve(versionId).resolve(versionId + ".json");
            if (Files.isRegularFile(json)) {
                int major = (int) Json.parse(json).path("javaVersion", "majorVersion").asLong(0);
                if (major > 0) {
                    return major;
                }
            }
        } catch (Exception ignored) {
            // 读不到就按 17
        }
        return 17;
    }

    //------------------------------------------------------------------
    // 库下载
    //------------------------------------------------------------------

    /** 下载一份版本 JSON 里声明的库（含 natives 分类器）。 */
    private static void downloadLibraries(Json.Value versionJson, Path mcDir, int jobs,
                                          Sources.Source source, Cancel cancel, Consumer<String> log)
            throws Exception {
        VersionMeta meta = VersionMeta.parse(versionJson.toPrettyString());
        List<VersionMeta.Library> libraries = meta.effectiveLibraries();

        ExecutorService pool = Executors.newFixedThreadPool(Math.max(1, Math.min(8, jobs)));
        cancel.onCancel(pool::shutdownNow);
        List<Future<?>> futures = new ArrayList<>();
        try {
            for (VersionMeta.Library lib : libraries) {
                if (cancel.isCancelled()) {
                    break;
                }
                if (lib.hasArtifact()) {
                    Path dest = mcDir.resolve("libraries").resolve(lib.artifactPath);
                    futures.add(pool.submit(() -> {
                        if (cancel.isCancelled()) {
                            return null;
                        }
                        Http.download(dest, Sources.fileCandidates(source, lib.artifactUrl),
                                lib.artifactSha1, lib.artifactSize, n -> {
                                }, lib.artifactPath, log);
                        return null;
                    }));
                }
                if (lib.nativesKey != null && lib.nativesInfo != null) {
                    String path = lib.nativesInfo.opt("path").asString("");
                    String url = lib.nativesInfo.opt("url").asString("");
                    String sha1 = lib.nativesInfo.opt("sha1").asString("");
                    // profile 里通常也带 size：有就传，让 Http 能用"大小不符"识别镜像的错误内容
                    long size = lib.nativesInfo.opt("size").asLong(-1);
                    if (!path.isEmpty() && !url.isEmpty()) {
                        Path dest = mcDir.resolve("libraries").resolve(path);
                        futures.add(pool.submit(() -> {
                            if (cancel.isCancelled()) {
                                return null;
                            }
                            Http.download(dest, Sources.fileCandidates(source, url),
                                    sha1.isBlank() ? null : sha1, size, n -> {
                                    }, path, log);
                            return null;
                        }));
                    }
                }
            }
            for (Future<?> f : futures) {
                f.get();
            }
        } finally {
            if (cancel.isCancelled()) {
                pool.shutdownNow();
            } else {
                pool.shutdown();
            }
        }
    }

    //------------------------------------------------------------------
    // 工具
    //------------------------------------------------------------------

    private static String uniqueId(Path versionsDir, String baseName) {
        String base = sanitize(baseName);
        if (base.isEmpty()) {
            base = "instance";
        }
        String candidate = base;
        for (int i = 2; i <= 200; i++) {
            if (!Files.exists(versionsDir.resolve(candidate))) {
                return candidate;
            }
            candidate = base + " (" + i + ")";
        }
        return base + " (" + System.currentTimeMillis() % 100000 + ")";
    }

    /** 版本目录名不能带 Windows 路径里的非法字符。 */
    public static String sanitize(String name) {
        if (name == null) {
            return "";
        }
        String cleaned = name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", " ")
                .replaceAll("\\s+", " ")
                .trim();
        while (cleaned.endsWith(".")) {
            cleaned = cleaned.substring(0, cleaned.length() - 1).trim();
        }
        if (cleaned.length() > 64) {
            cleaned = cleaned.substring(0, 64).trim();
        }
        return cleaned;
    }

    /** 点分版本比较：数字段按数值比，非数字段按字典序。 */
    public static int compareVersion(String a, String b) {
        String[] pa = a.split("[.\\-_+]");
        String[] pb = b.split("[.\\-_+]");
        int n = Math.max(pa.length, pb.length);
        for (int i = 0; i < n; i++) {
            String x = i < pa.length ? pa[i] : "0";
            String y = i < pb.length ? pb[i] : "0";
            boolean xn = x.matches("\\d+");
            boolean yn = y.matches("\\d+");
            int cmp;
            if (xn && yn) {
                cmp = new java.math.BigInteger(x).compareTo(new java.math.BigInteger(y));
            } else {
                cmp = x.compareTo(y);
            }
            if (cmp != 0) {
                return cmp;
            }
        }
        return 0;
    }


}
