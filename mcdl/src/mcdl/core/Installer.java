package mcdl.core;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionService;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 本体安装器：把某个原版版本需要的全部文件落进标准 {@code .minecraft} 目录。
 *
 * <p>流程与 PCL2 的 {@code DlClientFix}、HMCL 的 {@code GameInstallTask} 对齐：</p>
 * <ol>
 *   <li>拉版本清单 → 选版本 → 拉版本 JSON（写 versions/&lt;id&gt;/&lt;id&gt;.json）</li>
 *   <li>拉资源索引（assets/indexes/&lt;id&gt;.json）</li>
 *   <li>生成文件清单：客户端 jar、库、旧版 natives 分类器、日志配置、全部资源对象</li>
 *   <li>预扫描：已存在且校验通过的文件直接跳过；统计剩余字节数</li>
 *   <li>线程池并发下载（断点续传 + 镜像回退 + SHA-1 校验）</li>
 *   <li>解压 natives、复制 legacy/virtual 资源</li>
 * </ol>
 */
public final class Installer {

    /** 安装选项。 */
    public static final class Options {
        public Path dir;
        public Sources.Source source = Sources.Source.AUTO;
        public int jobs = 16;
        public boolean verify = false;
        public boolean force = false;
        public boolean assets = true;
        public boolean logging = true;
        public boolean virtualAssets = true;
        /** 只分析并打印计划，不真正下载。 */
        public boolean dryRun = false;
        /** 调试用：只下载资源对象，跳过 jar / 库 / 日志。 */
        public boolean assetsOnly = false;
        /** 调试用：最多下载多少个资源对象（0 表示不限制）。 */
        public int limitAssets = 0;
        /** 手动指定的 Java（null 表示自动选择）。 */
        public Path javaPath = null;
        public Consumer<String> log = s -> {
        };
    }

    public static final String KIND_CLIENT = "client";
    public static final String KIND_LIBRARY = "library";
    public static final String KIND_NATIVE = "native";
    public static final String KIND_INDEX = "index";
    public static final String KIND_ASSET = "asset";
    public static final String KIND_LOGGING = "logging";

    /** 一个待下载文件。 */
    static final class FileTask {
        final String label;
        final Path dest;
        final List<String> urls;
        final String sha1;
        final long size;
        final boolean optional;
        final String kind;
        boolean skip;
        long have;

        FileTask(String label, Path dest, List<String> urls, String sha1, long size,
                 boolean optional, String kind) {
            this.label = label;
            this.dest = dest;
            this.urls = urls;
            this.sha1 = sha1;
            this.size = size;
            this.optional = optional;
            this.kind = kind;
        }
    }

    /** 需要解压的旧版 natives jar。 */
    static final class NativesJar {
        final Path jar;
        final List<String> exclude;

        NativesJar(Path jar, List<String> exclude) {
            this.jar = jar;
            this.exclude = exclude;
        }
    }

    /** 旧版资源索引（virtual / map_to_resources）需要额外落盘的对象。 */
    static final class VirtualCopy {
        final Path source;
        final Path target;

        VirtualCopy(Path source, Path target) {
            this.source = source;
            this.target = target;
        }
    }

    /** 进度与状态，UI 每 300ms 轮询一次，CLI 自己打印。 */
    public static final class Stats {
        private final AtomicLong totalBytes = new AtomicLong();
        private final AtomicLong doneBytes = new AtomicLong();
        private final AtomicLong downloadedBytes = new AtomicLong();
        /** 资源索引等「辅助文件」的字节数：计入进度，也要计入总量，否则百分比/数值会错位。 */
        private final AtomicLong auxBytes = new AtomicLong();
        private final AtomicInteger totalFiles = new AtomicInteger();
        private final AtomicInteger doneFiles = new AtomicInteger();
        private final AtomicInteger skippedFiles = new AtomicInteger();
        private volatile String currentFile = "";
        private volatile String versionId = "";
        private volatile String versionType = "";
        private volatile String javaLabel = "";
        private volatile boolean finished;
        private volatile boolean failed;
        private volatile String error = "";
        private volatile long startNanos;
        private volatile String phase = "准备中";

        private long lastSampleTime;
        private long lastSampleBytes;
        private volatile double rate;

        void begin() {
            startNanos = System.nanoTime();
            lastSampleTime = startNanos;
        }

        void addBytes(long n) {
            if (n <= 0) {
                return;
            }
            doneBytes.addAndGet(n);
            downloadedBytes.addAndGet(n);
            long now = System.nanoTime();
            long last = lastSampleTime;
            if (now - last >= 500_000_000L) {
                synchronized (this) {
                    if (now - lastSampleTime >= 500_000_000L) {
                        double dt = (now - lastSampleTime) / 1e9;
                        rate = dt > 0 ? (downloadedBytes.get() - lastSampleBytes) / dt : 0;
                        lastSampleTime = now;
                        lastSampleBytes = downloadedBytes.get();
                    }
                }
            }
        }

        /** 资源索引等辅助文件的进度；同时记入 auxBytes，供计算总量时补齐。 */
        void addAuxBytes(long n) {
            if (n <= 0) {
                return;
            }
            auxBytes.addAndGet(n);
            addBytes(n);
        }

        long auxBytes() {
            return auxBytes.get();
        }

        void finish(boolean ok) {
            finished = true;
            failed = !ok;
            rate = 0;
        }

        public long totalBytes() {
            return totalBytes.get();
        }

        public long doneBytes() {
            return doneBytes.get();
        }

        public long downloadedBytes() {
            return downloadedBytes.get();
        }

        public int totalFiles() {
            return totalFiles.get();
        }

        public int doneFiles() {
            return doneFiles.get();
        }

        public int skippedFiles() {
            return skippedFiles.get();
        }

        public double rate() {
            return rate;
        }

        public long elapsedMillis() {
            return startNanos == 0 ? 0 : (System.nanoTime() - startNanos) / 1_000_000L;
        }

        public String currentFile() {
            return currentFile;
        }

        public String versionId() {
            return versionId;
        }

        public String versionType() {
            return versionType;
        }

        public String javaLabel() {
            return javaLabel;
        }

        public boolean finished() {
            return finished;
        }

        public boolean failed() {
            return failed;
        }

        public String error() {
            return error;
        }

        public String phase() {
            return phase;
        }

        public int percent() {
            long total = totalBytes.get();
            if (total <= 0) {
                return finished ? 100 : 0;
            }
            long done = doneBytes.get();
            if (done > total) {
                done = total;
            }
            return (int) Math.min(100, done * 100 / total);
        }

        public String etaLabel() {
            double r = rate;
            long remain = totalBytes.get() - doneBytes.get();
            if (r <= 1 || remain <= 0) {
                return "--:--";
            }
            long sec = (long) (remain / r);
            return String.format("%d:%02d", sec / 60, sec % 60);
        }
    }

    private final Options opt;
    private final Stats stats = new Stats();
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private volatile ExecutorService pool;

    public Installer(Options opt) {
        this.opt = opt;
    }

    public Stats stats() {
        return stats;
    }

    public void cancel() {
        cancelled.set(true);
        ExecutorService p = pool;
        if (p != null) {
            p.shutdownNow();
        }
    }

    public Stats install(String versionId) throws Exception {
        stats.begin();
        stats.versionId = versionId;
        Path root = opt.dir.toAbsolutePath().normalize();
        Files.createDirectories(root);

        opt.log.accept("安装目录：" + root);
        if (opt.source == Sources.Source.AUTO) {
            // 先测速，日志里才能显示最终选了哪个源
            Sources.autoPrefersBmcl(opt.log);
        }
        opt.log.accept("下载源：" + (opt.source == Sources.Source.AUTO
                ? Sources.autoChoiceLabel() : opt.source.label));

        stats.phase = "获取版本清单";
        Manifest.Data manifest = Manifest.fetch(opt.source, opt.log);
        Manifest.RemoteVersion remote = manifest.find(versionId);
        if (remote == null) {
            throw new IOException("版本清单中不存在版本 " + versionId
                    + "。可用 --list 查看全部版本 id。");
        }
        stats.versionType = remote.typeLabel();
        opt.log.accept("版本：" + remote.id + "（" + remote.typeLabel() + "，" + remote.dateLabel() + "）");

        stats.phase = "获取版本 JSON";
        checkCancelled();
        Path versionDir = root.resolve("versions").resolve(versionId);
        Files.createDirectories(versionDir);
        Path versionJson = versionDir.resolve(versionId + ".json");
        String jsonText = Http.getText(
                Sources.versionJsonCandidates(opt.source, versionId, remote.url), opt.log);
        if (remote.sha1 != null && !remote.sha1.isEmpty()) {
            String actual = sha1OfText(jsonText);
            if (!remote.sha1.equalsIgnoreCase(actual)) {
                throw new IOException("版本 JSON 的 SHA-1 不符（可能被镜像篡改或缓存过期），"
                        + "请换下载源重试。期望 " + remote.sha1 + "，实际 " + actual);
            }
        }
        Files.writeString(versionJson, jsonText, StandardCharsets.UTF_8);
        VersionMeta meta = VersionMeta.parse(jsonText);
        stats.javaLabel = meta.javaLabel();
        opt.log.accept("库 " + meta.libraries.size() + " 条");
        logJava(meta);

        // ---------- 资源索引 ----------
        Json.Value assetIndex = null;
        Path indexFile = null;
        if (opt.assets && meta.assetIndexUrl != null && !meta.assetIndexUrl.isEmpty()) {
            stats.phase = "获取资源索引";
            checkCancelled();
            indexFile = root.resolve("assets").resolve("indexes")
                    .resolve(meta.safeAssetIndexId() + ".json");
            boolean usable = false;
            if (Files.isRegularFile(indexFile) && !opt.force) {
                try {
                    assetIndex = Json.parse(indexFile);
                    usable = true;
                    opt.log.accept("复用已存在的资源索引 " + indexFile.getFileName());
                } catch (RuntimeException e) {
                    opt.log.accept("资源索引损坏，重新下载：" + e.getMessage());
                }
            }
            if (!usable) {
                List<String> urls = Sources.fileCandidates(opt.source, meta.assetIndexUrl);
                Http.download(indexFile, urls, meta.assetIndexSha1, meta.assetIndexSize,
                        stats::addAuxBytes, "资源索引 " + meta.assetIndexId, opt.log);
                assetIndex = Json.parse(indexFile);
            }
            int count = assetIndex.path("objects").size();
            opt.log.accept("资源索引 " + meta.assetIndexId + "：共 " + count + " 个对象");
        }

        // ---------- 生成文件清单 ----------
        stats.phase = "分析需要下载的文件";
        List<FileTask> files = new ArrayList<>();
        List<NativesJar> nativesJars = new ArrayList<>();

        if (!opt.assetsOnly && meta.clientUrl != null && !meta.clientUrl.isEmpty()) {
            files.add(new FileTask(versionId + ".jar",
                    versionDir.resolve(versionId + ".jar"),
                    Sources.clientJarCandidates(opt.source, versionId, meta.clientUrl),
                    meta.clientSha1, meta.clientSize, false, KIND_CLIENT));
        } else {
            if (!opt.assetsOnly) {
                opt.log.accept("警告：该版本 JSON 中没有客户端 jar 下载信息（可能只能通过启动器继承使用）");
            }
        }

        for (VersionMeta.Library lib : opt.assetsOnly ? List.<VersionMeta.Library>of() : meta.effectiveLibraries()) {
            if (lib.hasArtifact()) {
                files.add(new FileTask(shortName(lib.name),
                        root.resolve("libraries").resolve(lib.artifactPath),
                        Sources.fileCandidates(opt.source, lib.artifactUrl),
                        lib.artifactSha1, lib.artifactSize, false, KIND_LIBRARY));
            }
            String nPath = lib.nativesPath();
            if (nPath != null) {
                Json.Value info = lib.nativesInfo;
                String nUrl = info.opt("url").asString("");
                long nSize = info.opt("size").asLong(-1);
                String nSha1 = info.opt("sha1").asString("");
                Path dest = root.resolve("libraries").resolve(nPath);
                files.add(new FileTask("native " + shortName(lib.name), dest,
                        Sources.fileCandidates(opt.source, nUrl), nSha1, nSize, false, KIND_NATIVE));
                List<String> exclude = new ArrayList<>();
                if (lib.extractExclude != null) {
                    for (Json.Value e : lib.extractExclude.asList()) {
                        exclude.add(e.asString(""));
                    }
                }
                nativesJars.add(new NativesJar(dest, exclude));
            }
        }

        if (!opt.assetsOnly && opt.logging && meta.logFileUrl != null && !meta.logFileUrl.isEmpty()) {
            files.add(new FileTask("日志配置 " + meta.logFileId,
                    root.resolve("assets").resolve("log_configs").resolve(meta.logFileId),
                    Sources.fileCandidates(opt.source, meta.logFileUrl),
                    meta.logFileSha1, meta.logFileSize, true, KIND_LOGGING));
        }

        if (assetIndex != null) {
            Path objects = root.resolve("assets").resolve("objects");
            int assetCount = 0;
            for (Map.Entry<String, Json.Value> e : assetIndex.path("objects").entries()) {
                if (opt.limitAssets > 0 && assetCount >= opt.limitAssets) {
                    opt.log.accept("（调试：只取前 " + opt.limitAssets + " 个资源对象）");
                    break;
                }
                Json.Value obj = e.getValue();
                String hash = obj.opt("hash").asString("");
                long size = obj.opt("size").asLong(-1);
                if (hash.length() < 2) {
                    continue;
                }
                assetCount++;
                Path dest = objects.resolve(hash.substring(0, 2)).resolve(hash);
                files.add(new FileTask(e.getKey(), dest,
                        Sources.assetCandidates(opt.source, hash), hash, size, false, KIND_ASSET));
            }
        }

        // 少数老版本 JSON 会出现同一条库/分类器重复两遍的情况，按目标路径去重，
        // 否则两个线程会同时写同一个文件。
        List<FileTask> deduped = new ArrayList<>(files.size());
        java.util.Set<Path> seenDest = new java.util.HashSet<>();
        for (FileTask t : files) {
            if (seenDest.add(t.dest)) {
                deduped.add(t);
            } else {
                opt.log.accept("（忽略重复条目：" + t.label + "）");
            }
        }
        files = deduped;
        java.util.Set<Path> seenNatives = new java.util.HashSet<>();
        nativesJars.removeIf(n -> !seenNatives.add(n.jar));

        // ---------- 预扫描 ----------
        stats.phase = "检查已存在的文件";
        long total = 0;
        int remaining = 0;
        for (FileTask t : files) {
            checkCancelled();
            if (!opt.force && isComplete(t)) {
                t.skip = true;
                stats.skippedFiles.incrementAndGet();
                continue;
            }
            t.have = partSize(t);
            if (t.have > 0) {
                stats.addBytes(t.have);
            }
            total += Math.max(0, t.size > 0 ? t.size - t.have : 0);
            remaining++;
        }
        stats.totalBytes.set(total + stats.auxBytes());
        stats.totalFiles.set(remaining);
        opt.log.accept("共 " + files.size() + " 个文件，已存在 " + stats.skippedFiles.get()
                + "，待下载 " + remaining + " 个 / " + human(total + stats.auxBytes()));

        if (opt.assets && meta.assetIndexSize > 0 && assetIndex != null) {
            opt.log.accept("（资源对象总量 " + human(assetIndex.path("objects").size() == 0 ? 0
                    : indexTotalSize(assetIndex)) + "，已存在的不再下载）");
        }

        if (opt.dryRun) {
            int shown = 0;
            for (FileTask t : files) {
                if (!t.skip && shown < 25) {
                    opt.log.accept("[待下载] " + t.kind + "  " + (t.size > 0 ? human(t.size) : "?")
                            + "  " + root.relativize(t.dest));
                    shown++;
                }
            }
            if (remaining > shown) {
                opt.log.accept("… 其余 " + (remaining - shown) + " 个文件省略");
            }
            stats.totalBytes.set(total + stats.auxBytes());
            stats.doneBytes.set(0);
            stats.doneFiles.set(0);
            stats.phase = "分析完成（未下载）";
            stats.finish(true);
            opt.log.accept("分析完成：待下载 " + remaining + " 个文件 / "
                    + human(total + stats.auxBytes())
                    + "，跳过 " + stats.skippedFiles.get() + " 个已存在文件");
            return stats;
        }

        // ---------- 并发下载 ----------
        stats.phase = "下载中";
        pool = Executors.newFixedThreadPool(Math.max(1, Math.min(opt.jobs, 128)), r -> {
            Thread t = new Thread(r, "mcdl-dl");
            t.setDaemon(true);
            return t;
        });
        CompletionService<Void> cs = new ExecutorCompletionService<>(pool);
        List<Future<Void>> futures = new ArrayList<>();
        int submitted = 0;
        for (FileTask t : files) {
            if (t.skip) {
                continue;
            }
            submitted++;
            futures.add(cs.submit(() -> {
                runTask(t);
                return null;
            }));
        }

        Exception firstError = null;
        int received = 0;
        while (received < submitted) {
            Future<Void> completed;
            try {
                // 用 poll 而不是 take：一旦取消/首个错误，pool.shutdownNow() 会把还没开始的任务
                // 从队列里丢掉，这些任务的 future 永远不会完成，take() 会永久阻塞。
                completed = cs.poll(200, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("安装被中断", e);
            }
            if (completed == null) {
                if (cancelled.get() || firstError != null || pool.isTerminated()) {
                    break;
                }
                continue;
            }
            received++;
            try {
                completed.get();
            } catch (java.util.concurrent.CancellationException e) {
                // 被取消的任务没有结果，继续等下一个
            } catch (java.util.concurrent.ExecutionException e) {
                if (firstError == null) {
                    firstError = e.getCause() instanceof Exception ex ? ex : new IOException(e);
                    // 一个失败就停掉其余任务，避免继续浪费时间
                    for (Future<Void> f : futures) {
                        f.cancel(true);
                    }
                    pool.shutdownNow();
                    break;
                }
            }
        }
        if (firstError != null || cancelled.get()) {
            pool.shutdownNow();
            // 取消/失败时不再等满 10 秒：未完成的文件都是 .part，留着下次续传
            pool.awaitTermination(2, TimeUnit.SECONDS);
        } else {
            pool.shutdown();
            pool.awaitTermination(10, TimeUnit.SECONDS);
        }

        // 用户主动取消优先于「某个任务因被中断而报的错」
        if (cancelled.get()) {
            stats.error = "已取消";
            stats.finish(false);
            throw new IOException("已取消安装");
        }
        if (firstError != null) {
            stats.error = firstError.getMessage();
            stats.finish(false);
            throw firstError;
        }

        // ---------- natives 解压 ----------
        if (!nativesJars.isEmpty()) {
            stats.phase = "解压 natives";
            Path nativesDir = versionDir.resolve("natives");
            Files.createDirectories(nativesDir);
            for (NativesJar n : nativesJars) {
                checkCancelled();
                if (Files.isRegularFile(n.jar)) {
                    extractJar(n.jar, nativesDir, n.exclude);
                }
            }
        }

        // ---------- legacy / virtual 资源 ----------
        if (opt.virtualAssets && assetIndex != null && opt.assets) {
            stats.phase = "处理旧版资源索引";
            List<VirtualCopy> copies = buildVirtualCopies(root, assetIndex, meta);
            if (!copies.isEmpty()) {
                opt.log.accept("旧版资源索引：复制 " + copies.size() + " 个对象到虚拟资源目录");
                for (VirtualCopy c : copies) {
                    checkCancelled();
                    copyIfNeeded(c.source, c.target);
                }
            }
        }

        stats.doneBytes.set(Math.max(stats.doneBytes.get(), stats.totalBytes.get()));
        stats.doneFiles.set(stats.totalFiles.get());
        stats.phase = "完成";
        stats.finish(true);
        opt.log.accept("完成：" + versionId + "（" + human(stats.downloadedBytes()) + " 已下载，耗时 "
                + (stats.elapsedMillis() / 1000) + " 秒）");
        return stats;
    }

    /**
     * 扫描本机 Java，并说明「这个版本要什么 Java、本机有什么、推荐用哪个」。
     * 注意：这里只提示，不阻止安装——下载与 Java 是否存在无关。
     */
    private void logJava(VersionMeta meta) {
        int required = meta.javaMajor;
        List<JavaFinder.JavaInfo> javas;
        try {
            javas = JavaFinder.scan();
        } catch (RuntimeException e) {
            javas = List.of();
        }
        if (required > 0) {
            String comp = meta.javaComponent == null || meta.javaComponent.isEmpty()
                    ? "" : "（" + meta.javaComponent + "）";
            opt.log.accept("Java：该版本需要 Java " + required + comp);
        } else {
            opt.log.accept("Java：该版本没有声明 Java 要求");
        }
        if (javas.isEmpty()) {
            opt.log.accept("Java：本机未检测到任何 Java。下载不受影响；"
                    + "启动前请安装 Java " + (required > 0 ? required : "") + "。");
            return;
        }
        opt.log.accept("Java：本机找到 " + javas.size() + " 个（" + JavaFinder.summary(javas) + "）");

        boolean chosen = false;
        if (opt.javaPath != null) {
            JavaFinder.JavaInfo manual = JavaFinder.ofPath(opt.javaPath);
            if (manual != null) {
                JavaFinder.verify(manual);
                opt.log.accept("Java：使用手动指定 " + manual.describe()
                        + "（" + JavaFinder.matchLabel(manual, required) + "）");
                chosen = true;
            } else {
                opt.log.accept("Java：手动指定的路径无效：" + opt.javaPath);
            }
        }
        if (!chosen) {
            JavaFinder.JavaInfo best = JavaFinder.best(javas, required);
            if (best != null) {
                opt.log.accept("Java：自动选择 " + best.describe()
                        + "（" + JavaFinder.matchLabel(best, required) + "）");
            }
        }
        if (required > 0) {
            boolean exact = false;
            for (JavaFinder.JavaInfo j : javas) {
                if (j.exact(required)) {
                    exact = true;
                    break;
                }
            }
            if (!exact) {
                opt.log.accept("Java：本机没有 Java " + required + "，下载仍会继续；"
                        + "启动该版本前请在启动器里选择对应 Java（或用启动器自带的 Java 下载补装）。");
            }
        }
    }

    private void runTask(FileTask t) throws Exception {
        if (cancelled.get()) {
            throw new IOException("已取消");
        }
        stats.currentFile = t.label;
        try {
            Http.download(t.dest, t.urls, t.sha1, t.size, stats::addBytes, t.label, opt.log);
        } catch (IOException e) {
            if (t.optional) {
                opt.log.accept("可选项下载失败（忽略）：" + t.label + " — " + e.getMessage());
            } else {
                throw e;
            }
        }
        stats.doneFiles.incrementAndGet();
    }

    private boolean isComplete(FileTask t) {
        if (!Files.isRegularFile(t.dest)) {
            return false;
        }
        try {
            long len = Files.size(t.dest);
            if (t.size > 0 && len != t.size) {
                return false;
            }
            if (t.sha1 != null && !t.sha1.isEmpty() && opt.verify) {
                return t.sha1.equalsIgnoreCase(Http.sha1(t.dest));
            }
            return t.size > 0 || len > 0;
        } catch (IOException e) {
            return false;
        }
    }

    private static long partSize(FileTask t) {
        Path part = t.dest.resolveSibling(t.dest.getFileName() + ".part");
        try {
            return Files.isRegularFile(part) ? Files.size(part) : 0L;
        } catch (IOException e) {
            return 0L;
        }
    }

    private long indexTotalSize(Json.Value index) {
        long total = 0;
        for (Json.Value v : index.path("objects").values()) {
            total += Math.max(0, v.opt("size").asLong(0));
        }
        return total;
    }

    private List<VirtualCopy> buildVirtualCopies(Path root, Json.Value index, VersionMeta meta) {
        List<VirtualCopy> out = new ArrayList<>();
        boolean virtual = index.opt("virtual").asBoolean(false);
        boolean mapToResources = index.opt("map_to_resources").asBoolean(false);
        if (!virtual && !mapToResources) {
            return out;
        }
        Path objects = root.resolve("assets").resolve("objects");
        for (Map.Entry<String, Json.Value> e : index.path("objects").entries()) {
            String hash = e.getValue().opt("hash").asString("");
            if (hash.length() < 2) {
                continue;
            }
            Path source = objects.resolve(hash.substring(0, 2)).resolve(hash);
            if (!Files.isRegularFile(source)) {
                continue;
            }
            String name = e.getKey().replace('\\', '/');
            while (name.startsWith("/")) {
                name = name.substring(1);
            }
            if (name.contains("..")) {
                continue;
            }
            if (virtual) {
                out.add(new VirtualCopy(source,
                        root.resolve("assets").resolve("virtual")
                                .resolve(meta.safeAssetIndexId()).resolve(name)));
            }
            if (mapToResources) {
                out.add(new VirtualCopy(source, root.resolve("resources").resolve(name)));
            }
        }
        return out;
    }

    private static void copyIfNeeded(Path source, Path target) throws IOException {
        if (Files.isRegularFile(target) && Files.size(target) == Files.size(source)) {
            return;
        }
        Files.createDirectories(target.getParent());
        Files.copy(source, target, StandardCopyOption.REPLACE_EXISTING);
    }

    private static void extractJar(Path jar, Path outDir, List<String> exclude) throws IOException {
        try (ZipFile zf = new ZipFile(jar.toFile())) {
            var en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry entry = en.nextElement();
                if (entry.isDirectory()) {
                    continue;
                }
                String name = entry.getName().replace('\\', '/');
                boolean skip = name.contains("..");
                if (!skip) {
                    for (String ex : exclude) {
                        if (!ex.isEmpty() && name.startsWith(ex)) {
                            skip = true;
                            break;
                        }
                    }
                }
                if (skip) {
                    continue;
                }
                Path target = outDir.resolve(name);
                Path parent = target.getParent();
                if (parent != null) {
                    Files.createDirectories(parent);
                }
                try (InputStream in = zf.getInputStream(entry);
                     OutputStream out = Files.newOutputStream(target)) {
                    in.transferTo(out);
                }
            }
        }
    }

    private void checkCancelled() throws IOException {
        if (cancelled.get() || Thread.currentThread().isInterrupted()) {
            throw new IOException("已取消安装");
        }
    }

    private static String sha1OfText(String text) throws IOException {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-1");
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            md.update(bytes);
            return java.util.HexFormat.of().formatHex(md.digest());
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    private static String shortName(String maven) {
        String[] p = maven.split(":");
        if (p.length >= 3) {
            return p[1] + "-" + p[2];
        }
        return maven;
    }

    public static String human(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        }
        double kb = bytes / 1024.0;
        if (kb < 1024) {
            return String.format("%.1f KB", kb);
        }
        double mb = kb / 1024.0;
        if (mb < 1024) {
            return String.format("%.1f MB", mb);
        }
        return String.format("%.2f GB", mb / 1024.0);
    }

    /** 只读汇总，用于 --dry-run。 */
    public static List<String> planSummary(VersionMeta meta) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        counts.put("client", 0);
        counts.put("library", 0);
        counts.put("native", 0);
        counts.put("asset", 0);
        for (VersionMeta.Library lib : meta.effectiveLibraries()) {
            counts.merge("library", 1, Integer::sum);
            if (lib.nativesPath() != null) {
                counts.merge("native", 1, Integer::sum);
            }
        }
        List<String> out = new ArrayList<>();
        out.add("版本 " + meta.id + " / " + meta.type + " / " + meta.javaLabel());
        out.add("库：" + meta.libraries.size() + " 条（当前系统生效 "
                + meta.effectiveLibraries().size() + " 条）");
        out.add("客户端 jar：" + (meta.clientSize > 0 ? human(meta.clientSize) : "未知"));
        out.add("资源索引：" + meta.assetIndexId + "（" + human(meta.assetIndexSize) + "）");
        return out;
    }
}
