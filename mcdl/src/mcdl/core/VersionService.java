package mcdl.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * 按需读取某个版本 JSON 里的 {@code javaVersion.majorVersion}，带本地缓存。
 *
 * <p>GUI 里每次选中一个版本都要知道「这个版本要 Java 几」，但版本 JSON 只有 35 KB 左右，
 * 缓存到 {@code ~/.mcdl/cache/versions/<id>.json} 之后就不会再重复请求。</p>
 */
public final class VersionService {

    private VersionService() {
    }

    private static final Map<String, Integer> MEMORY = new ConcurrentHashMap<>();

    /** 返回该版本要求的 Java 主版本；未知返回 -1。 */
    public static int requiredJava(Manifest.RemoteVersion version, Sources.Source source,
                                   java.nio.file.Path mcDir, Consumer<String> log) throws IOException {
        Integer cached = MEMORY.get(version.id);
        if (cached != null) {
            return cached;
        }
        String text = null;
        // 1) 已安装的版本目录里就有现成的 JSON（离线也能判断）
        if (mcDir != null) {
            Path installed = mcDir.resolve("versions").resolve(version.id).resolve(version.id + ".json");
            if (Files.isRegularFile(installed)) {
                try {
                    text = Files.readString(installed, StandardCharsets.UTF_8);
                } catch (IOException ignored) {
                    text = null;
                }
            }
        }
        // 2) 版本缓存
        Path cache = cacheFile(version.id);
        if (text == null && Files.isRegularFile(cache)) {
            try {
                text = Files.readString(cache, StandardCharsets.UTF_8);
            } catch (IOException ignored) {
                text = null;
            }
        }
        if (text == null) {
            text = Http.getText(
                    Sources.versionJsonCandidates(source, version.id, version.url), log);
            writeCache(cache, text);
        }
        int major = -1;
        try {
            major = (int) Json.parse(text).path("javaVersion", "majorVersion").asLong(-1);
        } catch (RuntimeException ignored) {
            // JSON 损坏就当未知
        }
        MEMORY.put(version.id, major);
        return major;
    }

    private static Path cacheFile(String id) {
        String safe = id.replaceAll("[\\\\/:*?\"<>|]", "_").toLowerCase(Locale.ROOT);
        return Path.of(System.getProperty("user.home"), ".mcdl", "cache", "versions", safe + ".json");
    }

    private static void writeCache(Path cache, String text) {
        try {
            Files.createDirectories(cache.getParent());
            Path tmp = cache.resolveSibling(cache.getFileName() + ".tmp");
            Files.writeString(tmp, text, StandardCharsets.UTF_8);
            Files.move(tmp, cache, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException ignored) {
            // 缓存失败不影响主流程
        }
    }
}
