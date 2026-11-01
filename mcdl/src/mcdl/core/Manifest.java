package mcdl.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * 版本清单（version_manifest_v2.json）。
 *
 * <p>和 PCL2 / HMCL 一样会把清单缓存到本地：10 分钟内直接读缓存，网络失败时退回过期缓存，
 * 避免每次打开界面都要在慢网络上等十几秒。</p>
 */
public final class Manifest {

    private Manifest() {
    }

    private static final long CACHE_TTL_MILLIS = 10 * 60 * 1000L;

    public static final class RemoteVersion {
        public final String id;
        public final String type;
        public final String url;
        public final String sha1;
        public final String releaseTime;

        RemoteVersion(String id, String type, String url, String sha1, String releaseTime) {
            this.id = id;
            this.type = type;
            this.url = url;
            this.sha1 = sha1;
            this.releaseTime = releaseTime;
        }

        /** 用于表格显示的中文类型名。 */
        public String typeLabel() {
            return switch (type == null ? "" : type) {
                case "release" -> "正式版";
                case "snapshot" -> "快照";
                case "old_beta" -> "远古 Beta";
                case "old_alpha" -> "远古 Alpha";
                default -> type == null ? "未知" : type;
            };
        }

        public String dateLabel() {
            if (releaseTime == null || releaseTime.length() < 10) {
                return releaseTime == null ? "" : releaseTime;
            }
            return releaseTime.substring(0, 10);
        }
    }

    public static final class Data {
        public final String latestRelease;
        public final String latestSnapshot;
        public final List<RemoteVersion> versions;
        /** 是否来自本地缓存。 */
        public final boolean fromCache;

        Data(String latestRelease, String latestSnapshot, List<RemoteVersion> versions, boolean fromCache) {
            this.latestRelease = latestRelease;
            this.latestSnapshot = latestSnapshot;
            this.versions = versions;
            this.fromCache = fromCache;
        }

        public RemoteVersion find(String id) {
            for (RemoteVersion v : versions) {
                if (v.id.equals(id)) {
                    return v;
                }
            }
            return null;
        }
    }

    public static Data fetch(Sources.Source source, Consumer<String> log) throws IOException {
        return fetch(source, log, false);
    }

    /** 拉取并解析版本清单。forceRefresh 为 true 时忽略缓存。 */
    public static Data fetch(Sources.Source source, Consumer<String> log, boolean forceRefresh) throws IOException {
        if (source == Sources.Source.AUTO) {
            if (!forceRefresh) {
                // 自动模式下先看两个源的缓存，谁新用谁：避免为了测速先等两次网络往返
                Data cachedAuto = readAutoCache(log);
                if (cachedAuto != null) {
                    return cachedAuto;
                }
            }
            Sources.autoPrefersBmcl(log);
        }
        List<String> urls = Sources.manifestCandidates(source);
        Path cache = cacheFile(urls);

        if (!forceRefresh) {
            Data cached = readCache(cache, log);
            if (cached != null) {
                return cached;
            }
        }

        try {
            String text = Http.getText(urls, log);
            Data data = parse(text, false);
            writeCache(cache, text);
            return data;
        } catch (IOException e) {
            Data stale = readCache(cache, null, true);
            if (stale != null) {
                if (log != null) {
                    log.accept("获取版本清单失败（" + e.getMessage() + "），使用过期缓存");
                }
                return stale;
            }
            throw e;
        }
    }

    private static Data parse(String text, boolean fromCache) throws IOException {
        Json.Value root = Json.parse(text);
        String release = root.path("latest", "release").asString("");
        String snapshot = root.path("latest", "snapshot").asString("");
        List<RemoteVersion> list = new ArrayList<>();
        for (Json.Value v : root.path("versions").asList()) {
            String id = v.opt("id").asString("");
            if (id.isEmpty()) {
                continue;
            }
            list.add(new RemoteVersion(
                    id,
                    v.opt("type").asString(""),
                    v.opt("url").asString(""),
                    v.opt("sha1").asString(""),
                    v.opt("releaseTime").asString("")));
        }
        if (list.isEmpty()) {
            throw new IOException("版本清单为空，可能是下载源返回了异常内容");
        }
        return new Data(release, snapshot, list, fromCache);
    }

    private static Path cacheFile(List<String> urls) {
        String primary = urls.isEmpty() ? "" : urls.get(0);
        String name = primary.contains("bangbang93") ? "manifest-bmclapi.json" : "manifest-official.json";
        return cachePath(name);
    }

    private static Path cachePath(String name) {
        return Path.of(System.getProperty("user.home"), ".mcdl", "cache", name);
    }

    /** AUTO 模式：两个源哪份缓存更新且未过期，就用哪份。 */
    private static Data readAutoCache(Consumer<String> log) {
        Path best = null;
        long bestTime = 0L;
        for (String name : new String[]{"manifest-official.json", "manifest-bmclapi.json"}) {
            Path p = cachePath(name);
            try {
                if (Files.isRegularFile(p)) {
                    long t = Files.getLastModifiedTime(p).toMillis();
                    if (t > bestTime) {
                        bestTime = t;
                        best = p;
                    }
                }
            } catch (IOException ignored) {
                // 忽略单个缓存文件的元数据错误
            }
        }
        if (best == null || System.currentTimeMillis() - bestTime > CACHE_TTL_MILLIS) {
            return null;
        }
        return readCache(best, log);
    }

    private static Data readCache(Path cache, Consumer<String> log) {
        return readCache(cache, log, false);
    }

    private static Data readCache(Path cache, Consumer<String> log, boolean allowStale) {
        try {
            if (!Files.isRegularFile(cache)) {
                return null;
            }
            if (!allowStale) {
                long age = System.currentTimeMillis() - Files.getLastModifiedTime(cache).toMillis();
                if (age > CACHE_TTL_MILLIS) {
                    return null;
                }
            }
            String text = Files.readString(cache, StandardCharsets.UTF_8);
            Data data = parse(text, true);
            if (log != null) {
                log.accept("使用本地缓存的版本清单（" + cache.getFileName() + "）");
            }
            return data;
        } catch (Exception e) {
            return null;
        }
    }

    private static void writeCache(Path cache, String text) {
        try {
            Files.createDirectories(cache.getParent());
            Path tmp = cache.resolveSibling(cache.getFileName() + ".tmp");
            Files.writeString(tmp, text, StandardCharsets.UTF_8);
            Files.move(tmp, cache, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException ignored) {
            // 缓存写不进去不影响主流程
        }
    }
}
