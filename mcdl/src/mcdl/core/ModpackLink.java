package mcdl.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.net.URLEncoder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 从剪贴板/文本中的 Modrinth、CurseForge 链接解析出可下载的整合包文件。
 *
 * <p>支持：Modrinth 项目页、Modrinth 版本页、CurseForge 项目页、CurseForge 文件页，
 * 以及以 {@code .mrpack} / {@code .zip} 结尾的直链。</p>
 */
public final class ModpackLink {

    private ModpackLink() {
    }

    /** 解析结果。 */
    public static final class Resolved {
        public final List<String> urls;
        public final String fileName;
        public final String suggestedName;

        Resolved(List<String> urls, String fileName, String suggestedName) {
            this.urls = urls;
            this.fileName = fileName;
            this.suggestedName = suggestedName;
        }
    }

    private static final Pattern URL_PATTERN = Pattern.compile("https?://[^\\s\"'<>]+");
    private static final Pattern MODRINTH = Pattern.compile(
            "^https?://(?:www\\.)?modrinth\\.com/modpack/([^/?#]+)(?:/version/([^/?#]+))?");
    private static final Pattern CURSEFORGE = Pattern.compile(
            "^https?://(?:www\\.|legacy\\.)?curseforge\\.com/minecraft/modpacks/([^/?#]+)(?:/files/(\\d+))?");

    /** 从一段文本里找第一个可识别的整合包链接。 */
    public static String findUrl(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        Matcher m = URL_PATTERN.matcher(text);
        while (m.find()) {
            String url = trimUrl(m.group());
            if (isPackUrl(url)) {
                return url;
            }
        }
        return null;
    }

    public static boolean isPackUrl(String url) {
        String u = url.toLowerCase(java.util.Locale.ROOT);
        if (!(u.startsWith("http://") || u.startsWith("https://"))) {
            return false;
        }
        if (u.endsWith(".mrpack") || u.endsWith(".zip")) {
            return true;
        }
        return MODRINTH.matcher(url).find() || CURSEFORGE.matcher(url).find();
    }

    /** 解析链接，返回下载候选与文件名。 */
    public static Resolved resolve(String url, Consumer<String> log) throws Exception {
        String clean = trimUrl(url);
        Matcher mr = MODRINTH.matcher(clean);
        if (mr.find()) {
            return resolveModrinth(mr.group(1), mr.group(2), log);
        }
        Matcher cf = CURSEFORGE.matcher(clean);
        if (cf.find()) {
            return resolveCurseForge(cf.group(1), cf.group(2), log);
        }
        String lower = clean.toLowerCase(java.util.Locale.ROOT);
        if (lower.endsWith(".mrpack") || lower.endsWith(".zip")) {
            String name = fileName(clean);
            return new Resolved(List.of(clean), name, stripExt(name));
        }
        throw new IOException("无法识别的链接类型：" + clean);
    }

    /** 下载解析结果到临时目录。 */
    public static Path download(Resolved resolved, Consumer<String> log) throws Exception {
        Path dir = Files.createTempDirectory("mcdl-link-");
        String safe = resolved.fileName.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (safe.isBlank()) {
            safe = "pack.mrpack";
        }
        Path file = dir.resolve(safe);
        Http.download(file, resolved.urls, null, -1, n -> {
        }, resolved.fileName, log);
        return file;
    }

    //----------------------------------------------------------------------

    private static Resolved resolveModrinth(String slug, String versionId, Consumer<String> log)
            throws Exception {
        Json.Value json;
        if (versionId != null && !versionId.isBlank()) {
            json = Json.parse(Http.getText(List.of(
                    "https://api.modrinth.com/v2/version/" + versionId), log));
        } else {
            Json.Value versions = Json.parse(Http.getText(List.of(
                    "https://api.modrinth.com/v2/project/" + slug + "/version"), log));
            List<Json.Value> list = versions.asList();
            if (list.isEmpty()) {
                throw new IOException("Modrinth 项目没有可用版本：" + slug);
            }
            json = list.get(0);
        }
        Json.Value file = pickMrpack(json);
        String name = file.opt("filename").asString("");
        String dl = file.opt("url").asString("");
        if (dl.isBlank()) {
            throw new IOException("Modrinth 版本里没有 .mrpack 文件");
        }
        return new Resolved(List.of(dl), name.isBlank() ? slug + ".mrpack" : name, slug);
    }

    private static Json.Value pickMrpack(Json.Value version) throws IOException {
        for (Json.Value f : version.path("files").asList()) {
            String name = f.opt("filename").asString("");
            if (name.endsWith(".mrpack")) {
                return f;
            }
        }
        throw new IOException("该 Modrinth 版本不提供 .mrpack");
    }

    private static Resolved resolveCurseForge(String slug, String fileId, Consumer<String> log)
            throws Exception {
        Json.Value data = Json.parse(Http.getText(List.of(
                "https://api.cfwidget.com/minecraft/modpacks/" + slug), log));
        Json.Value file = null;
        if (fileId != null && !fileId.isBlank()) {
            long id = Long.parseLong(fileId);
            for (Json.Value f : data.path("files").asList()) {
                if (f.opt("id").asLong(0) == id) {
                    file = f;
                    break;
                }
            }
        }
        if (file == null) {
            Json.Value latest = data.path("download");
            if (latest.opt("id").asLong(0) > 0) {
                file = latest;
            } else if (!data.path("files").asList().isEmpty()) {
                file = data.path("files").asList().get(0);
            }
        }
        if (file == null) {
            throw new IOException("无法从 CurseForge 项目获取文件信息：" + slug);
        }
        long id = file.opt("id").asLong(0);
        String name = file.opt("name").asString("");
        if (id <= 0 || name.isBlank()) {
            throw new IOException("CurseForge 文件信息不完整");
        }
        String encoded = URLEncoder.encode(name, StandardCharsets.UTF_8).replace("+", "%20");
        String path = (id / 1000) + "/" + (id % 1000) + "/" + encoded;
        List<String> urls = new ArrayList<>();
        urls.add("https://mediafilez.forgecdn.net/files/" + path);
        urls.add("https://edge.forgecdn.net/files/" + path);
        return new Resolved(urls, name, slug);
    }

    private static String trimUrl(String url) {
        String s = url.trim();
        while (s.endsWith(".") || s.endsWith(",") || s.endsWith(")") || s.endsWith("]")) {
            s = s.substring(0, s.length() - 1);
        }
        return s;
    }

    private static String fileName(String url) {
        String p = url;
        int q = p.indexOf('?');
        if (q >= 0) {
            p = p.substring(0, q);
        }
        int slash = p.lastIndexOf('/');
        return slash >= 0 ? p.substring(slash + 1) : p;
    }

    private static String stripExt(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }
}
