package mcdl.core;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.LongConsumer;

/**
 * HTTP 工具：小文件直接读成字符串，大文件断点续传 + 重试 + SHA-1 校验。
 *
 * <p>关键点（也是仿制 PCL2 / HMCL 时最容易漏的）：</p>
 * <ul>
 *   <li>镜像与官方都要能回退：一个 URL 失败就试下一个。</li>
 *   <li>下载先写 {@code .part}，校验通过后再原子改名，避免半截文件被当成已安装。</li>
 *   <li>续传用 {@code Range: bytes=N-}，服务器忽略 Range 返回 200 时要从头覆盖写。</li>
 *   <li>BMCLAPI 大量返回 302 到签名下载节点，必须跟随重定向（HttpClient.NORMAL）。</li>
 * </ul>
 */
public final class Http {

    private Http() {
    }

    public static final String UA = "MCDL/1.0 (Minecraft version downloader)";

    public static final HttpClient CLIENT = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .followRedirects(HttpClient.Redirect.NORMAL)
            .connectTimeout(Duration.ofSeconds(20))
            .build();

    private static final int ATTEMPTS_PER_URL = 3;
    private static final int BUFFER = 128 * 1024;

    /** 可重试的下载失败（连接断开、HTTP 5xx、超时…）：同一个地址再试有意义。 */
    public static final class RetryableException extends IOException {
        public RetryableException(String message) {
            super(message);
        }
    }

    /**
     * 内容不可用：服务器确实返回了 200，但内容不是我们要的（SHA-1 不符 / 大小不符）。
     *
     * <p>这类错误在同一个地址上重试几乎没有意义——镜像把错误页缓存下来后会一直返回同一份
     * 内容，重试只会让用户白等 3 轮（每轮可能 60s 超时）。所以 {@link #download} 收到它
     * 后直接换下一个候选地址。注意它仍然是 {@link IOException}，调用方代码不用改。</p>
     */
    public static final class BadContentException extends IOException {
        public BadContentException(String message) {
            super(message);
        }
    }

    /** 依次尝试候选 URL，读取文本内容。 */
    public static String getText(List<String> urls, Consumer<String> log) throws IOException {
        return getText(urls, java.util.Map.of(), log);
    }

    /** 带自定义请求头（如 CurseForge 的 x-api-key）的文本请求。 */
    public static String getText(List<String> urls, java.util.Map<String, String> headers,
                                 Consumer<String> log) throws IOException {
        return fetchText(urls, headers, log, true);
    }

    /**
     * 读取非 JSON 的文本（如 maven 的 maven-metadata.xml）。
     * 与 {@link #getText} 的区别只有一条：不把以 {@code <} 开头的响应当成错误页。
     */
    public static String getRawText(List<String> urls, Consumer<String> log) throws IOException {
        return fetchText(urls, java.util.Map.of(), log, false);
    }

    private static String fetchText(List<String> urls, java.util.Map<String, String> headers,
                                    Consumer<String> log, boolean rejectHtml) throws IOException {
        IOException last = null;
        for (String url : urls) {
            for (int attempt = 1; attempt <= 2; attempt++) {
                try {
                    HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                            .timeout(Duration.ofSeconds(40))
                            .header("User-Agent", UA)
                            .GET();
                    if (headers != null) {
                        headers.forEach(builder::header);
                    }
                    HttpRequest req = builder.build();
                    HttpResponse<String> resp = CLIENT.send(req, HttpResponse.BodyHandlers.ofString());
                    int code = resp.statusCode();
                    if (code / 100 == 2) {
                        String body = resp.body();
                        String trimmed = body == null ? "" : body.stripLeading();
                        if (rejectHtml && trimmed.startsWith("<")) {
                            throw new RetryableException("返回的是 HTML 而不是 JSON：" + url);
                        }
                        return body;
                    }
                    throw new RetryableException("HTTP " + code + "：" + url);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException("下载被中断", e);
                } catch (IOException e) {
                    last = e;
                    if (log != null && attempt < 2) {
                        log.accept("  重试 " + url + "（" + e.getMessage() + "）");
                    }
                    sleep(400L * attempt);
                }
            }
        }
        throw last != null ? last : new IOException("没有可用的下载地址");
    }

    /**
     * 下载一个文件到 dest。
     *
     * @param urls         候选地址（按顺序尝试）
     * @param sha1         期望 SHA-1，可为 null
     * @param expectedSize 期望大小，未知填 -1
     * @param onBytes      每读到一块数据回调一次（用于进度统计）
     */
    public static void download(Path dest, List<String> urls, String sha1, long expectedSize,
                                LongConsumer onBytes, String label, Consumer<String> log)
            throws IOException {
        if (urls == null || urls.isEmpty()) {
            throw new IOException("没有可用的下载地址：" + label);
        }
        Path parent = dest.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        Path part = dest.resolveSibling(dest.getFileName() + ".part");

        IOException last = null;
        for (String url : urls) {
            // 内容错误（SHA-1 / 大小不符）不在同一个地址上重试：直接标记并换下一个候选
            boolean badContent = false;
            for (int attempt = 1; attempt <= ATTEMPTS_PER_URL; attempt++) {
                try {
                    if (tryOne(url, part, sha1, expectedSize, onBytes, label, log)) {
                        try {
                            Files.move(part, dest, StandardCopyOption.REPLACE_EXISTING,
                                    StandardCopyOption.ATOMIC_MOVE);
                        } catch (IOException atomicFailed) {
                            Files.move(part, dest, StandardCopyOption.REPLACE_EXISTING);
                        }
                        return;
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException("下载被中断", e);
                } catch (IOException e) {
                    last = e;
                    if (log != null) {
                        log.accept("  失败（" + shortUrl(url) + "）：" + e.getMessage());
                    }
                    if (e instanceof BadContentException) {
                        // 内容本身错了，同一个地址再试也是同样的结果，省掉退避与超时
                        badContent = true;
                        break;
                    }
                    if (attempt < ATTEMPTS_PER_URL) {
                        sleep(500L * attempt);
                    }
                }
            }
            if (badContent && log != null) {
                log.accept("  该地址返回的内容不正确，直接换下一个下载地址");
            }
        }
        String reason = last == null ? "未知原因" : last.getMessage();
        if (last instanceof BadContentException) {
            reason = "所有下载地址返回的内容都校验不通过（" + reason + "）";
        }
        throw new IOException("下载失败：" + label + "（" + reason + "）", last);
    }

    /** 单次尝试；返回 true 表示 .part 已完整且校验通过。 */
    private static boolean tryOne(String url, Path part, String sha1, long expectedSize,
                                  LongConsumer onBytes, String label, Consumer<String> log)
            throws IOException, InterruptedException {
        long have = Files.isRegularFile(part) ? Files.size(part) : 0L;
        if (expectedSize > 0 && have > expectedSize) {
            Files.deleteIfExists(part);
            have = 0L;
        }
        if (expectedSize > 0 && have == expectedSize) {
            if (sha1 == null || sha1.equalsIgnoreCase(sha1(part))) {
                return true;
            }
            Files.deleteIfExists(part);
            have = 0L;
        }

        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(60))
                .header("User-Agent", UA)
                .GET();
        if (have > 0) {
            builder.header("Range", "bytes=" + have + "-");
        }
        HttpResponse<InputStream> resp;
        try {
            resp = CLIENT.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException e) {
            throw new RetryableException(e.getMessage() == null ? "连接失败" : e.getMessage());
        }
        int code = resp.statusCode();
        boolean append;
        if (code == 206) {
            append = true;
        } else if (code == 200) {
            // 服务器忽略了 Range（或本来就没有断点），从头写
            append = false;
            have = 0L;
        } else if (code == 416) {
            resp.body().close();
            if (sha1 != null && Files.isRegularFile(part) && sha1.equalsIgnoreCase(sha1(part))) {
                return true;
            }
            Files.deleteIfExists(part);
            throw new RetryableException("HTTP 416（断点无效，已重置）");
        } else {
            resp.body().close();
            throw new RetryableException("HTTP " + code);
        }

        long written = 0L;
        try (InputStream in = resp.body();
             OutputStream out = Files.newOutputStream(part,
                     StandardOpenOption.CREATE,
                     StandardOpenOption.WRITE,
                     append ? StandardOpenOption.APPEND : StandardOpenOption.TRUNCATE_EXISTING)) {
            byte[] buf = new byte[BUFFER];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                written += n;
                if (onBytes != null) {
                    onBytes.accept(n);
                }
            }
        }

        long actual = Files.size(part);
        if (expectedSize > 0 && actual != expectedSize) {
            // 大小不符说明这份内容不是我们要的文件（镜像错误页、截断的缓存…）。
            // 删掉 .part：换源后若沿用这份字节续传，拼出来的文件必然还是错的。
            Files.deleteIfExists(part);
            throw new BadContentException("大小不符：期望 " + expectedSize + "，实际 " + actual);
        }
        if (sha1 != null) {
            String actualSha1 = sha1(part);
            if (!sha1.equalsIgnoreCase(actualSha1)) {
                Files.deleteIfExists(part);
                throw new BadContentException("SHA-1 不符：期望 " + sha1 + "，实际 " + actualSha1);
            }
        }
        if (log != null && written > 0) {
            log.accept("  完成 " + label);
        }
        return true;
    }

    private static String shortUrl(String url) {
        try {
            URI u = URI.create(url);
            String path = u.getPath();
            if (path != null && path.length() > 48) {
                path = "..." + path.substring(path.length() - 45);
            }
            return u.getHost() + path;
        } catch (RuntimeException e) {
            return url;
        }
    }

    public static String sha1(Path file) throws IOException {
        try (InputStream in = Files.newInputStream(file)) {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] buf = new byte[BUFFER];
            int n;
            while ((n = in.read(buf)) > 0) {
                md.update(buf, 0, n);
            }
            return HexFormat.of().formatHex(md.digest());
        } catch (NoSuchAlgorithmException e) {
            throw new IOException("当前 JVM 不支持 SHA-1", e);
        }
    }

    public static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
