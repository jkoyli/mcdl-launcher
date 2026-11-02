package mcdl.core;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;

/**
 * 下载源与镜像映射。
 *
 * <p>规则参考 HMCL 的 {@code HMCLDownloadProvider}（{@code MirrorRule} 表）与
 * PCL2 的 {@code DlSource*Get} 系列函数：官方 URL 保持不变，镜像 URL 按「域名前缀 →
 * 镜像根路径」做字符串替换。BMCLAPI 的路径布局与官方不完全一致，这里逐条核对过：</p>
 *
 * <pre>
 * 官方                                           BMCLAPI
 * https://piston-meta.mojang.com/...          →  https://bmclapi2.bangbang93.com/...            （302 到下载节点）
 * https://piston-data.mojang.com/...          →  https://bmclapi2.bangbang93.com/...
 * https://launchermeta.mojang.com/...         →  https://bmclapi2.bangbang93.com/...
 * https://libraries.minecraft.net/a/b.jar     →  https://bmclapi2.bangbang93.com/libraries/a/b.jar
 * https://resources.download.minecraft.net/xx/hash
 *                                             →  https://bmclapi2.bangbang93.com/assets/xx/hash
 *                                                （注意：没有 objects 这一段）
 * 版本 JSON（快捷路径）                        →  https://bmclapi2.bangbang93.com/versions/&lt;id&gt;/&lt;id&gt;.json
 * 客户端 jar（快捷路径）                       →  https://bmclapi2.bangbang93.com/versions/&lt;id&gt;/&lt;id&gt;.jar
 * </pre>
 */
public final class Sources {

    private Sources() {
    }

    /** 下载源。AUTO 会在启动时对两个清单做一次测速，选快的那个优先。 */
    public enum Source {
        AUTO("自动（测速）"),
        OFFICIAL("官方 Mojang"),
        BMCLAPI("BMCLAPI 镜像");

        public final String label;

        Source(String label) {
            this.label = label;
        }

        @Override
        public String toString() {
            return label;
        }

        public static Source byKey(String key) {
            if (key == null) {
                return AUTO;
            }
            return switch (key.trim().toLowerCase()) {
                case "official", "mojang", "offical" -> OFFICIAL;
                case "bmcl", "bmclapi", "mirror" -> BMCLAPI;
                default -> AUTO;
            };
        }
    }

    public static final String BMCL_ROOT = "https://bmclapi2.bangbang93.com";
    public static final String MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
    public static final String MANIFEST_URL_BMCL = BMCL_ROOT + "/mc/game/version_manifest_v2.json";

    private static volatile Boolean autoPrefersBmcl;

    /** 用户自定义镜像源（按优先级排列，列表顺序即优先级）。 */
    public record CustomMirror(String name, String base) {
    }

    private static final java.util.List<CustomMirror> CUSTOM = new java.util.ArrayList<>();

    static {
        loadCustomMirrors();
    }

    public static synchronized java.util.List<CustomMirror> customMirrors() {
        return new java.util.ArrayList<>(CUSTOM);
    }

    public static synchronized void addCustomMirror(String name, String base) throws IOException {
        String n = name == null ? "" : name.trim();
        String b = normalizeBase(base);
        if (b == null) {
            throw new IOException("镜像地址必须以 https:// 开头"
                    + "（本机调试可用 http://127.0.0.1 或 http://localhost）");
        }
        if (n.isBlank()) {
            n = b;
        }
        CUSTOM.add(new CustomMirror(n, b));
        saveCustomMirrors();
    }

    public static synchronized void removeCustomMirror(int index) {
        if (index >= 0 && index < CUSTOM.size()) {
            CUSTOM.remove(index);
            saveCustomMirrors();
        }
    }

    public static synchronized void moveCustomMirrorTop(int index) {
        if (index > 0 && index < CUSTOM.size()) {
            CustomMirror m = CUSTOM.remove(index);
            CUSTOM.add(0, m);
            saveCustomMirrors();
        }
    }

    /**
     * 校验并规范化镜像根地址。
     *
     * <p>只接受 {@code https://}：自定义镜像参与所有下载（包括会被执行的加载器安装器），
     * 用 http 传输等于把完整性校验交给中间人。唯一的例外是本地回环
     * （{@code http://127.0.0.1}、{@code http://localhost}），方便自建镜像调试。</p>
     *
     * @return 去掉末尾斜杠的根地址；不合法返回 {@code null}
     */
    private static String normalizeBase(String base) {
        if (base == null) {
            return null;
        }
        String b = base.trim();
        while (b.endsWith("/")) {
            b = b.substring(0, b.length() - 1);
        }
        if (b.isEmpty()) {
            return null;
        }
        URI uri;
        try {
            uri = URI.create(b);
        } catch (IllegalArgumentException e) {
            return null;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            return null;
        }
        if ("https".equals(scheme)) {
            return b;
        }
        if ("http".equals(scheme) && isLoopbackHost(host)) {
            return b;
        }
        return null;
    }

    /** 本地回环：http 只对这类地址放行。 */
    private static boolean isLoopbackHost(String host) {
        String h = host.toLowerCase(Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) {
            h = h.substring(1, h.length() - 1);
        }
        return h.equals("localhost") || h.equals("127.0.0.1") || h.equals("::1")
                || h.startsWith("127.");
    }

    private static Path customMirrorFile() {
        return Path.of(System.getProperty("user.home"), ".mcdl", "sources.json");
    }

    private static void loadCustomMirrors() {
        CUSTOM.clear();
        Path file = customMirrorFile();
        if (!Files.isRegularFile(file)) {
            return;
        }
        try {
            Json.Value root = Json.parse(file);
            Json.Value arr = root.isArray() ? root : root.path("mirrors");
            for (Json.Value v : arr.asList()) {
                String name = v.opt("name").asString("");
                String raw = v.opt("base").asString("");
                String base = normalizeBase(raw);
                if (base != null) {
                    CUSTOM.add(new CustomMirror(name.isBlank() ? base : name, base));
                } else if (!raw.isBlank()) {
                    // 老配置里可能存着 http 镜像：跳过而不是让整个列表崩掉
                    System.err.println("已忽略不安全的镜像地址（仅支持 https://）：" + raw);
                }
            }
        } catch (Exception ignored) {
            // 配置损坏则忽略
        }
    }

    private static void saveCustomMirrors() {
        Json.Value arr = Json.Value.arr();
        for (CustomMirror m : CUSTOM) {
            Json.Value o = Json.Value.obj();
            o.put("name", m.name());
            o.put("base", m.base());
            arr.add(o);
        }
        try {
            Path file = customMirrorFile();
            Files.createDirectories(file.getParent());
            Files.writeString(file, arr.toPrettyString(), StandardCharsets.UTF_8);
        } catch (IOException ignored) {
            // 写不进去不影响本次运行
        }
    }

    private static List<String> withCustom(Source source, List<String> existing, String bmclPath) {
        if (source == Source.OFFICIAL || bmclPath == null) {
            return existing;
        }
        List<String> out = new ArrayList<>();
        for (CustomMirror m : customMirrors()) {
            out.add(m.base() + bmclPath);
        }
        out.addAll(existing);
        return dedupe(out);
    }

    /** 镜像健康度。 */
    public static final class MirrorStatus {
        public final String name;
        public final String base;
        public final boolean builtin;
        public final long latencyMs;
        public final double successRate;

        MirrorStatus(String name, String base, boolean builtin, long latencyMs, double successRate) {
            this.name = name;
            this.base = base;
            this.builtin = builtin;
            this.latencyMs = latencyMs;
            this.successRate = successRate;
        }
    }

    /** 对官方、BMCLAPI 与自定义镜像做 3 次探测，返回延迟与成功率。 */
    public static List<MirrorStatus> probeAll() {
        List<MirrorStatus> out = new ArrayList<>();
        out.add(probeOne("官方 Mojang", "https://piston-meta.mojang.com",
                MANIFEST_URL, true));
        out.add(probeOne("BMCLAPI", BMCL_ROOT, MANIFEST_URL_BMCL, true));
        for (CustomMirror m : customMirrors()) {
            out.add(probeOne(m.name(), m.base(),
                    m.base() + "/mc/game/version_manifest_v2.json", false));
        }
        return out;
    }

    private static MirrorStatus probeOne(String name, String base, String manifestUrl, boolean builtin) {
        int ok = 0;
        long total = 0;
        for (int i = 0; i < 3; i++) {
            long ms = probe(manifestUrl);
            if (ms > 0) {
                ok++;
                total += ms;
            }
        }
        long avg = ok == 0 ? -1 : total / ok;
        return new MirrorStatus(name, base, builtin, avg, ok / 3.0);
    }

    /** 供 UI/CLI 显示：AUTO 最终选了谁。 */
    public static String autoChoiceLabel() {
        Boolean b = autoPrefersBmcl;
        if (b == null) {
            return "自动（未测速）";
        }
        return b ? "自动 → BMCLAPI" : "自动 → 官方";
    }

    /**
     * 对官方与 BMCLAPI 的版本清单各做一次计时探测，决定 AUTO 的优先顺序。
     * 结果缓存在进程内，重复调用不会重复测速。
     */
    public static boolean autoPrefersBmcl(Consumer<String> log) {
        Boolean cached = autoPrefersBmcl;
        if (cached != null) {
            return cached;
        }
        synchronized (Sources.class) {
            if (autoPrefersBmcl != null) {
                return autoPrefersBmcl;
            }
            long official = probe(MANIFEST_URL);
            long bmcl = probe(MANIFEST_URL_BMCL);
            boolean preferBmcl = bmcl > 0 && (official <= 0 || bmcl <= official);
            autoPrefersBmcl = preferBmcl;
            if (log != null) {
                log.accept(String.format("测速：官方 %s，BMCLAPI %s → 优先使用 %s",
                        ms(official), ms(bmcl), preferBmcl ? "BMCLAPI" : "官方"));
            }
            return preferBmcl;
        }
    }

    private static String ms(long v) {
        return v <= 0 ? "超时" : v + " ms";
    }

    private static long probe(String url) {
        long start = System.nanoTime();
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(5))
                    .header("User-Agent", Http.UA)
                    // 只要前 1 个字节，避免在慢网络上为了测速把整份清单拖下来
                    .header("Range", "bytes=0-0")
                    .GET().build();
            HttpResponse<java.io.InputStream> resp =
                    Http.CLIENT.send(req, HttpResponse.BodyHandlers.ofInputStream());
            try (java.io.InputStream in = resp.body()) {
                if (resp.statusCode() / 100 != 2) {
                    return -1;
                }
                in.read();
            }
            return (System.nanoTime() - start) / 1_000_000L;
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            return -1;
        }
    }

    /** 版本清单的候选 URL（按优先顺序）。 */
    public static List<String> manifestCandidates(Source source) {
        List<String> base;
        switch (source) {
            case OFFICIAL:
                base = List.of(MANIFEST_URL);
                break;
            case BMCLAPI:
                base = List.of(MANIFEST_URL_BMCL, MANIFEST_URL);
                break;
            default:
                base = autoPrefersBmcl(null)
                        ? List.of(MANIFEST_URL_BMCL, MANIFEST_URL)
                        : List.of(MANIFEST_URL, MANIFEST_URL_BMCL);
        }
        return withCustom(source, base, "/mc/game/version_manifest_v2.json");
    }

    /** 版本 JSON 的候选 URL。officialUrl 来自清单；id 用于 BMCLAPI 的快捷路径。 */
    public static List<String> versionJsonCandidates(Source source, String id, String officialUrl) {
        List<String> out = new ArrayList<>(3);
        String bmcl = mapToBmcl(officialUrl);
        switch (source) {
            case OFFICIAL -> out.add(officialUrl);
            case BMCLAPI -> {
                if (bmcl != null) {
                    out.add(bmcl);
                }
                out.add(BMCL_ROOT + "/versions/" + id + "/" + id + ".json");
                out.add(officialUrl);
            }
            default -> {
                if (autoPrefersBmcl(null)) {
                    if (bmcl != null) {
                        out.add(bmcl);
                    }
                    out.add(BMCL_ROOT + "/versions/" + id + "/" + id + ".json");
                    out.add(officialUrl);
                } else {
                    out.add(officialUrl);
                    if (bmcl != null) {
                        out.add(bmcl);
                    }
                }
            }
        }
        return withCustom(source, dedupe(out), "/versions/" + id + "/" + id + ".json");
    }

    /** 客户端 jar 的候选 URL。 */
    public static List<String> clientJarCandidates(Source source, String versionId, String officialUrl) {
        List<String> out = new ArrayList<>(3);
        String bmcl = mapToBmcl(officialUrl);
        String shortcut = BMCL_ROOT + "/versions/" + versionId + "/" + versionId + ".jar";
        switch (source) {
            case OFFICIAL -> out.add(officialUrl);
            case BMCLAPI -> {
                if (bmcl != null) {
                    out.add(bmcl);
                }
                out.add(shortcut);
                out.add(officialUrl);
            }
            default -> {
                if (autoPrefersBmcl(null)) {
                    if (bmcl != null) {
                        out.add(bmcl);
                    }
                    out.add(shortcut);
                    out.add(officialUrl);
                } else {
                    out.add(officialUrl);
                    if (bmcl != null) {
                        out.add(bmcl);
                    }
                }
            }
        }
        return dedupe(out);
    }

    /** 任意官方 URL 的候选列表（库、日志配置、资源索引等）。 */
    public static List<String> fileCandidates(Source source, String officialUrl) {
        String bmcl = mapToBmcl(officialUrl);
        List<String> base;
        switch (source) {
            case OFFICIAL -> base = List.of(officialUrl);
            case BMCLAPI -> base = bmcl == null ? List.of(officialUrl) : dedupe(List.of(bmcl, officialUrl));
            default -> {
                if (bmcl == null) {
                    base = List.of(officialUrl);
                } else {
                    base = autoPrefersBmcl(null)
                            ? dedupe(List.of(bmcl, officialUrl))
                            : dedupe(List.of(officialUrl, bmcl));
                }
            }
        }
        String path = bmcl == null ? null : bmcl.substring(BMCL_ROOT.length());
        return withCustom(source, base, path);
    }

    /** 资源对象的候选 URL。hash 形如 b62ca8ec...（不带路径）。 */
    public static List<String> assetCandidates(Source source, String hash) {
        String loc = hash.substring(0, 2) + "/" + hash;
        String official = "https://resources.download.minecraft.net/" + loc;
        String bmcl = BMCL_ROOT + "/assets/" + loc;
        List<String> base;
        switch (source) {
            case OFFICIAL -> base = List.of(official);
            case BMCLAPI -> base = List.of(bmcl, official);
            default -> base = autoPrefersBmcl(null) ? List.of(bmcl, official) : List.of(official, bmcl);
        }
        return withCustom(source, base, "/assets/" + loc);
    }

    /**
     * 官方 URL → BMCLAPI URL；不认识的域名返回 null（表示没有镜像，只能用官方）。
     */
    public static String mapToBmcl(String officialUrl) {
        if (officialUrl == null || officialUrl.isEmpty()) {
            return null;
        }
        // 少数旧版 JSON 里库地址是 http://
        String url = officialUrl.replace("http://", "https://");

        String[][] directPrefixes = {
                {"https://piston-meta.mojang.com", ""},
                {"https://piston-data.mojang.com", ""},
                {"https://launchermeta.mojang.com", ""},
                {"https://launcher.mojang.com", ""},
                {"https://libraries.minecraft.net", "/libraries"},
                {"https://resources.download.minecraft.net", "/assets"},
                {"https://maven.minecraftforge.net", "/maven"},
                {"https://files.minecraftforge.net/maven", "/maven"},
                {"https://maven.neoforged.net/releases", "/maven"},
                {"https://meta.fabricmc.net", "/fabric-meta"},
                {"https://maven.fabricmc.net", "/maven"},
                {"https://meta.quiltmc.org", "/quilt-meta"},
                {"https://maven.quiltmc.org/repository/release", "/maven"},
                {"https://authlib-injector.yushi.moe", "/mirrors/authlib-injector"},
        };
        for (String[] p : directPrefixes) {
            if (url.startsWith(p[0])) {
                String rest = url.substring(p[0].length());
                if (!rest.startsWith("/")) {
                    rest = "/" + rest;
                }
                return BMCL_ROOT + p[1] + rest;
            }
        }
        // Maven Central 的库走腾讯云镜像（与 HMCL 相同）
        if (url.startsWith("https://repo1.maven.org/maven2")
                || url.startsWith("https://repo.maven.apache.org/maven2")) {
            String rest = url.substring(url.indexOf("/maven2") + "/maven2".length());
            return "https://mirrors.cloud.tencent.com/nexus/repository/maven-public" + rest;
        }
        return null;
    }

    public static List<String> dedupe(List<String> urls) {
        List<String> out = new ArrayList<>(urls.size());
        for (String u : urls) {
            if (u != null && !u.isEmpty() && !out.contains(u)) {
                out.add(u);
            }
        }
        return out;
    }
}
