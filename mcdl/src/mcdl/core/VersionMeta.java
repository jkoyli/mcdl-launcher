package mcdl.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 版本 JSON（{id}.json）的模型，只保留下载本体所需的部分。
 */
public final class VersionMeta {

    public final String id;
    public final String type;
    public final String mainClass;
    public final String assets;
    public final int javaMajor;
    public final String javaComponent;

    public final String assetIndexId;
    public final String assetIndexUrl;
    public final String assetIndexSha1;
    public final long assetIndexSize;

    public final String clientUrl;
    public final String clientSha1;
    public final long clientSize;

    public final String logFileId;
    public final String logFileUrl;
    public final String logFileSha1;
    public final long logFileSize;

    public final List<Library> libraries;

    private VersionMeta(Builder b) {
        this.id = b.id;
        this.type = b.type;
        this.mainClass = b.mainClass;
        this.assets = b.assets;
        this.javaMajor = b.javaMajor;
        this.javaComponent = b.javaComponent;
        this.assetIndexId = b.assetIndexId;
        this.assetIndexUrl = b.assetIndexUrl;
        this.assetIndexSha1 = b.assetIndexSha1;
        this.assetIndexSize = b.assetIndexSize;
        this.clientUrl = b.clientUrl;
        this.clientSha1 = b.clientSha1;
        this.clientSize = b.clientSize;
        this.logFileId = b.logFileId;
        this.logFileUrl = b.logFileUrl;
        this.logFileSha1 = b.logFileSha1;
        this.logFileSize = b.logFileSize;
        this.libraries = b.libraries;
    }

    /** 当前环境下需要下载的库（已按 rules 过滤）。 */
    public List<Library> effectiveLibraries() {
        List<Library> out = new ArrayList<>(libraries.size());
        for (Library lib : libraries) {
            if (lib.applies()) {
                out.add(lib);
            }
        }
        return out;
    }

    public static VersionMeta parse(String json) {
        Json.Value root = Json.parse(json);
        Builder b = new Builder();
        b.id = root.opt("id").asString("");
        b.type = root.opt("type").asString("");
        b.mainClass = root.opt("mainClass").asString("");
        b.assets = root.opt("assets").asString("");
        Json.Value java = root.path("javaVersion");
        b.javaMajor = (int) java.opt("majorVersion").asLong(0);
        b.javaComponent = java.opt("component").asString("");

        Json.Value index = root.path("assetIndex");
        b.assetIndexId = index.opt("id").asString("");
        b.assetIndexUrl = index.opt("url").asString("");
        b.assetIndexSha1 = index.opt("sha1").asString("");
        b.assetIndexSize = index.opt("size").asLong(-1);

        Json.Value client = root.path("downloads", "client");
        b.clientUrl = client.opt("url").asString("");
        b.clientSha1 = client.opt("sha1").asString("");
        b.clientSize = client.opt("size").asLong(-1);

        Json.Value logging = root.path("logging", "client");
        Json.Value logFile = logging.path("file");
        b.logFileId = logFile.opt("id").asString("");
        b.logFileUrl = logFile.opt("url").asString("");
        b.logFileSha1 = logFile.opt("sha1").asString("");
        b.logFileSize = logFile.opt("size").asLong(-1);

        for (Json.Value v : root.path("libraries").asList()) {
            Library lib = Library.parse(v);
            if (lib != null) {
                b.libraries.add(lib);
            }
        }
        return new VersionMeta(b);
    }

    /** 一个库条目。 */
    public static final class Library {
        public final String name;
        public final String artifactPath;
        public final String artifactUrl;
        public final String artifactSha1;
        public final long artifactSize;

        /** 旧版 natives 需要的分类器键（如 natives-windows），无则 null。 */
        public final String nativesKey;
        /** 分类器下载信息（path/url/sha1/size），无则 null。 */
        public final Json.Value nativesInfo;
        /** extract.exclude，无则 null。 */
        public final Json.Value extractExclude;
        public final Json.Value rules;

        private Library(String name, String artifactPath, String artifactUrl, String artifactSha1,
                        long artifactSize, String nativesKey, Json.Value nativesInfo,
                        Json.Value extractExclude, Json.Value rules) {
            this.name = name;
            this.artifactPath = artifactPath;
            this.artifactUrl = artifactUrl;
            this.artifactSha1 = artifactSha1;
            this.artifactSize = artifactSize;
            this.nativesKey = nativesKey;
            this.nativesInfo = nativesInfo;
            this.extractExclude = extractExclude;
            this.rules = rules;
        }

        public boolean applies() {
            return Rules.allowed(rules);
        }

        public boolean hasArtifact() {
            return artifactUrl != null && !artifactUrl.isEmpty() && artifactPath != null && !artifactPath.isEmpty();
        }

        static Library parse(Json.Value v) {
            String name = v.opt("name").asString("");
            if (name.isEmpty()) {
                return null;
            }
            Json.Value rules = v.get("rules");
            Json.Value downloads = v.get("downloads");

            String path = null;
            String url = null;
            String sha1 = null;
            long size = -1;

            Json.Value natives = v.get("natives");
            boolean hasDownloads = downloads != null && downloads.isObject();
            boolean nativesOnly = natives != null && natives.isObject();
            Json.Value artifact = hasDownloads ? downloads.get("artifact") : null;
            if (artifact != null && artifact.isObject()) {
                path = artifact.opt("path").asString(null);
                url = artifact.opt("url").asString(null);
                sha1 = artifact.opt("sha1").asString(null);
                size = artifact.opt("size").asLong(-1);
            } else if (!hasDownloads && !nativesOnly) {
                // 只有非常旧的 JSON（没有 downloads 段）才用 name + url 基址推导；
                // 有 downloads 但没有 artifact 的条目是「只有分类器」的库（如 jinput-platform），
                // 它本来就没有主 jar，不能去请求（否则 404）。
                path = mavenPath(name);
                String base = v.opt("url").asString("https://libraries.minecraft.net/");
                if (path != null && !base.isEmpty()) {
                    if (!base.endsWith("/")) {
                        base = base + "/";
                    }
                    url = base + path;
                }
            }

            // natives：只有当前系统的那一条才有意义
            String nativesKey = null;
            Json.Value nativesInfo = null;
            if (nativesOnly) {
                String key = Rules.nativesKey(natives);
                if (key != null) {
                    key = key.replace("${arch}", "x86".equals(Rules.osArch()) ? "32" : "64");
                    Json.Value classifiers = downloads == null ? null : downloads.get("classifiers");
                    Json.Value info = classifiers == null ? null : classifiers.get(key);
                    if (info != null && info.isObject()) {
                        nativesKey = key;
                        nativesInfo = info;
                    }
                }
            }

            Json.Value extract = v.get("extract");
            Json.Value exclude = extract == null ? null : extract.get("exclude");
            return new Library(name, path, url, sha1, size, nativesKey, nativesInfo, exclude, rules);
        }

        /** 由 Maven 坐标计算仓库内相对路径：group:artifact:version[:classifier][@ext]。 */
        public static String mavenPath(String name) {
            if (name == null || name.isEmpty()) {
                return null;
            }
            String ext = "jar";
            String coord = name;
            int at = coord.indexOf('@');
            if (at >= 0) {
                ext = coord.substring(at + 1);
                coord = coord.substring(0, at);
            }
            String[] parts = coord.split(":");
            if (parts.length < 3) {
                return null;
            }
            String group = parts[0].replace('.', '/');
            String artifact = parts[1];
            String version = parts[2];
            String classifier = parts.length > 3 ? parts[3] : null;
            StringBuilder sb = new StringBuilder();
            sb.append(group).append('/').append(artifact).append('/').append(version).append('/');
            sb.append(artifact).append('-').append(version);
            if (classifier != null && !classifier.isEmpty()) {
                sb.append('-').append(classifier);
            }
            sb.append('.').append(ext);
            return sb.toString();
        }

        /** 分类器在磁盘上的相对路径（libraries/ 之下）。 */
        public String nativesPath() {
            if (nativesInfo == null) {
                return null;
            }
            String p = nativesInfo.opt("path").asString("");
            if (!p.isEmpty()) {
                return p;
            }
            String url = nativesInfo.opt("url").asString("");
            if (!url.isEmpty() && url.contains("/libraries/")) {
                return url.substring(url.indexOf("/libraries/") + "/libraries/".length());
            }
            return mavenPath(nameForClassifier());
        }

        private String nameForClassifier() {
            String[] parts = name.split("@")[0].split(":");
            if (parts.length < 3) {
                return name;
            }
            return parts[0] + ":" + parts[1] + ":" + parts[2] + ":" + nativesKey;
        }
    }

    private static final class Builder {
        String id;
        String type;
        String mainClass;
        String assets;
        int javaMajor;
        String javaComponent;
        String assetIndexId;
        String assetIndexUrl;
        String assetIndexSha1;
        long assetIndexSize;
        String clientUrl;
        String clientSha1;
        long clientSize;
        String logFileId;
        String logFileUrl;
        String logFileSha1;
        long logFileSize;
        final List<Library> libraries = new ArrayList<>();
    }

    /** 供 UI 显示：这个版本需要哪个 Java。 */
    public String javaLabel() {
        if (javaMajor <= 0) {
            return "未知";
        }
        String comp = javaComponent == null || javaComponent.isEmpty() ? "" : "（" + javaComponent + "）";
        return "Java " + javaMajor + comp;
    }

    /** 资源索引 id 的安全化（少数字符不能直接做文件名）。 */
    public String safeAssetIndexId() {
        if (assetIndexId == null || assetIndexId.isEmpty()) {
            return "legacy";
        }
        return assetIndexId.replaceAll("[\\\\/:*?\"<>|]", "_").toLowerCase(Locale.ROOT);
    }

    /** 名称 → 版本记录，便于调试。 */
    public Map<String, String> summary() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("type", type);
        m.put("java", javaLabel());
        m.put("assetIndex", assetIndexId);
        m.put("libraries", String.valueOf(libraries.size()));
        return m;
    }
}
