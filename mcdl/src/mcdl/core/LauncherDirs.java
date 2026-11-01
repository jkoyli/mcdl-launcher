package mcdl.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * 自动识别本机 PCL2 / HMCL 使用的游戏目录（.minecraft）。
 *
 * <p>识别来源：</p>
 * <ul>
 *   <li><b>PCL2</b>：注册表 {@code HKCU\Software\PCL\LaunchFolders}；以及找到
 *       {@code Plain Craft Launcher 2.exe} 后读 {@code <exeDir>/PCL/Setup.ini} 里的
 *       {@code LaunchFolderSelect}（PCL 的当前游戏目录就存在这里）。</li>
 *   <li><b>HMCL</b>：{@code %APPDATA%/.hmcl/config/user-game-directories.json} 的
 *       {@code directories[].path}（HMCL 3.17+ 的目录列表）。</li>
 *   <li><b>兜底</b>：在桌面 / 文档 / 下载 / 用户目录 / 各盘符浅层扫描「含 versions + assets
 *       的目录」，以及带 {@code PCL.ini} 或版本内 {@code .hmcl} 标记的目录。</li>
 * </ul>
 */
public final class LauncherDirs {

    private LauncherDirs() {
    }

    /** 一个候选游戏目录。 */
    public static final class DirInfo {
        public final Path dir;
        public final String source;
        public final boolean current;
        public final int versions;
        public final long lastUsed;

        DirInfo(Path dir, String source, boolean current, int versions, long lastUsed) {
            this.dir = dir;
            this.source = source;
            this.current = current;
            this.versions = versions;
            this.lastUsed = lastUsed;
        }

        public String label() {
            StringBuilder sb = new StringBuilder(dir.toString());
            sb.append("  ·  ").append(source);
            if (versions > 0) {
                sb.append("，").append(versions).append(" 个版本");
            }
            return sb.toString();
        }

        public int score() {
            int s = versions * 10;
            if (current) {
                s += 1000;
            }
            if (source.startsWith("PCL") || source.startsWith("HMCL")) {
                s += 100;
            }
            return s;
        }
    }

    /** 扫描并返回按优先级排序的候选目录（去重）。 */
    public static List<DirInfo> detect() {
        Map<String, DirInfo> byPath = new LinkedHashMap<>();
        String userHome = System.getProperty("user.home");
        String appData = System.getenv("APPDATA");

        // ---------- HMCL ----------
        for (Path hmclConfig : hmclConfigCandidates()) {
            readHmclGameDirectories(hmclConfig, byPath);
        }

        // ---------- PCL ----------
        String launchFolders = regQuery("HKCU\\Software\\PCL", "LaunchFolders");
        if (launchFolders != null) {
            for (String part : launchFolders.split("\\|")) {
                if (!part.isBlank()) {
                    add(byPath, Paths.get(part.trim()), "PCL", false);
                }
            }
        }
        for (Path exe : findPclExecutables(userHome, appData)) {
            Path setup = exe.getParent().resolve("PCL").resolve("Setup.ini");
            if (!Files.isRegularFile(setup)) {
                setup = exe.getParent().resolve("Setup.ini");
            }
            if (Files.isRegularFile(setup)) {
                String selected = iniValue(setup, "LaunchFolderSelect");
                if (selected != null && !selected.isBlank()) {
                    add(byPath, Paths.get(selected.trim()), "PCL 当前", true);
                }
            }
            // PCL 便携版常见布局：exe 旁边就是 .minecraft
            add(byPath, exe.getParent().resolve(".minecraft"), "PCL 相邻", false);
        }

        // ---------- 默认目录 ----------
        Path defaultDir = defaultDir();
        if (Files.isDirectory(defaultDir)) {
            add(byPath, defaultDir, "默认", false);
        }

        // ---------- 兜底扫描 ----------
        int[] budget = {1500};
        for (Path root : scanRoots(userHome, appData)) {
            scanGameDirs(root, 3, byPath, budget);
        }

        List<DirInfo> list = new ArrayList<>(byPath.values());
        list.sort(Comparator.comparingInt(DirInfo::score).reversed()
                .thenComparing(d -> d.dir.toString()));
        return list;
    }

    /** 最佳目录；没有任何候选时返回默认目录。 */
    public static Path best() {
        List<DirInfo> list = detect();
        return list.isEmpty() ? defaultDir() : list.get(0).dir;
    }

    public static Path defaultDir() {
        String appData = System.getenv("APPDATA");
        if (appData != null && !appData.isBlank()) {
            return Paths.get(appData, ".minecraft");
        }
        return Paths.get(System.getProperty("user.home"), ".minecraft");
    }

    //----------------------------------------------------------------------
    // HMCL
    //----------------------------------------------------------------------

    private static List<Path> hmclConfigCandidates() {
        List<Path> out = new ArrayList<>();
        String appData = System.getenv("APPDATA");
        String userHome = System.getProperty("user.home");
        if (appData != null) {
            out.add(Paths.get(appData, ".hmcl", "config", "user-game-directories.json"));
            out.add(Paths.get(appData, ".hmcl", "hmcl.json"));
        }
        if (userHome != null) {
            out.add(Paths.get(userHome, ".hmcl", "config", "user-game-directories.json"));
            out.add(Paths.get(userHome, ".hmcl", "hmcl.json"));
        }
        return out;
    }

    private static void readHmclGameDirectories(Path file, Map<String, DirInfo> out) {
        if (!Files.isRegularFile(file)) {
            return;
        }
        try {
            Json.Value root = Json.parse(file);
            for (Json.Value dir : root.path("directories").asList()) {
                String path = dir.opt("path").asString("");
                if (!path.isBlank()) {
                    add(out, Paths.get(path), "HMCL", true);
                }
            }
            // 老版 hmcl.json：gameDir / gameDirectory
            String legacy = root.opt("gameDir").asString("");
            if (legacy.isBlank()) {
                legacy = root.opt("gameDirectory").asString("");
            }
            if (!legacy.isBlank()) {
                add(out, Paths.get(legacy), "HMCL", true);
            }
        } catch (Exception ignored) {
            // 配置格式不认识就跳过
        }
    }

    //----------------------------------------------------------------------
    // PCL
    //----------------------------------------------------------------------

    /** 在常见位置找 Plain Craft Launcher 2.exe（限制深度，避免全盘扫描）。 */
    private static List<Path> findPclExecutables(String userHome, String appData) {
        List<Path> roots = new ArrayList<>();
        for (String base : new String[]{userHome, System.getenv("PUBLIC")}) {
            if (base == null) {
                continue;
            }
            roots.add(Paths.get(base, "Desktop"));
            roots.add(Paths.get(base, "Documents"));
            roots.add(Paths.get(base, "Downloads"));
        }
        for (String base : new String[]{System.getenv("ProgramFiles"), System.getenv("ProgramFiles(x86)")}) {
            if (base != null) {
                roots.add(Paths.get(base));
            }
        }
        List<Path> found = new ArrayList<>();
        for (Path root : roots) {
            findNamedFile(root, 4, "Plain Craft Launcher 2.exe", found, 4);
            findNamedFile(root, 4, "PCL.exe", found, 4);
        }
        return found;
    }

    private static void findNamedFile(Path dir, int depth, String name, List<Path> out, int limit) {
        if (depth < 0 || dir == null || !Files.isDirectory(dir) || out.size() >= limit) {
            return;
        }
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path p : ds) {
                if (out.size() >= limit) {
                    return;
                }
                if (Files.isRegularFile(p) && p.getFileName().toString().equalsIgnoreCase(name)) {
                    out.add(p);
                }
            }
        } catch (IOException | RuntimeException ignored) {
            return;
        }
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path p : ds) {
                if (depth > 0 && Files.isDirectory(p)) {
                    String n = p.getFileName().toString();
                    if (n.startsWith(".") || n.equalsIgnoreCase("node_modules") || n.equalsIgnoreCase("Windows")) {
                        continue;
                    }
                    findNamedFile(p, depth - 1, name, out, limit);
                }
            }
        } catch (IOException | RuntimeException ignored) {
            // 忽略无权限目录
        }
    }

    private static String iniValue(Path ini, String key) {
        try {
            for (String line : Files.readAllLines(ini, Charset.defaultCharset())) {
                int i = line.indexOf(':');
                if (i > 0 && line.substring(0, i).trim().equalsIgnoreCase(key)) {
                    return line.substring(i + 1).trim();
                }
            }
        } catch (IOException ignored) {
            // 读不了就算了
        }
        return null;
    }

    //----------------------------------------------------------------------
    // 兜底扫描
    //----------------------------------------------------------------------

    private static List<Path> scanRoots(String userHome, String appData) {
        List<Path> roots = new ArrayList<>();
        if (appData != null) {
            roots.add(Paths.get(appData));
        }
        for (String drive : new String[]{"C:", "D:", "E:", "F:"}) {
            roots.add(Paths.get(drive + "\\"));
            roots.add(Paths.get(drive + "\\Games"));
            roots.add(Paths.get(drive + "\\游戏"));
            roots.add(Paths.get(drive + "\\Minecraft"));
        }
        return roots;
    }

    private static void scanGameDirs(Path dir, int depth, Map<String, DirInfo> out, int[] budget) {
        if (depth < 0 || dir == null || !Files.isDirectory(dir) || budget[0]-- <= 0) {
            return;
        }
        if (looksLikeGameDir(dir)) {
            add(out, dir, detectSource(dir), false);
            return;
        }
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path p : ds) {
                if (!Files.isDirectory(p)) {
                    continue;
                }
                String n = p.getFileName().toString();
                if (n.startsWith(".") || n.equalsIgnoreCase("Windows") || n.equalsIgnoreCase("$Recycle.Bin")
                        || n.equalsIgnoreCase("node_modules")) {
                    continue;
                }
                scanGameDirs(p, depth - 1, out, budget);
            }
        } catch (IOException | RuntimeException ignored) {
            // 忽略无权限目录
        }
    }

    private static boolean looksLikeGameDir(Path dir) {
        return Files.isDirectory(dir.resolve("versions"))
                && (Files.isDirectory(dir.resolve("assets")) || Files.isDirectory(dir.resolve("libraries")));
    }

    private static String detectSource(Path dir) {
        if (Files.isRegularFile(dir.resolve("PCL.ini"))) {
            return "PCL";
        }
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(dir.resolve("versions"))) {
            for (Path v : ds) {
                if (Files.isDirectory(v.resolve(".hmcl"))) {
                    return "HMCL";
                }
            }
        } catch (IOException | RuntimeException ignored) {
            // 忽略
        }
        return "游戏目录";
    }

    //----------------------------------------------------------------------

    private static void add(Map<String, DirInfo> out, Path dir, String source, boolean current) {
        if (dir == null) {
            return;
        }
        Path normalized;
        try {
            normalized = dir.toAbsolutePath().normalize();
        } catch (RuntimeException e) {
            return;
        }
        if (!Files.isDirectory(normalized)) {
            return;
        }
        String key = normalized.toString().toLowerCase(Locale.ROOT);
        int versions = countVersions(normalized);
        long last = lastModified(normalized.resolve("versions"));
        DirInfo existing = out.get(key);
        if (existing == null) {
            out.put(key, new DirInfo(normalized, source, current, versions, last));
            return;
        }
        String merged = existing.source;
        if (!merged.contains(source) && !source.contains(merged)) {
            merged = merged + " + " + source;
        }
        boolean cur = existing.current || current;
        int v = Math.max(existing.versions, versions);
        long lm = Math.max(existing.lastUsed, last);
        out.put(key, new DirInfo(normalized, merged, cur, v, lm));
    }

    private static int countVersions(Path dir) {
        Path versions = dir.resolve("versions");
        if (!Files.isDirectory(versions)) {
            return 0;
        }
        int n = 0;
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(versions)) {
            for (Path ignored : ds) {
                n++;
            }
        } catch (IOException | RuntimeException ignored) {
            // 忽略
        }
        return n;
    }

    private static long lastModified(Path p) {
        try {
            return Files.getLastModifiedTime(p).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    private static String regQuery(String key, String value) {
        if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win")) {
            return null;
        }
        Process process = null;
        try {
            process = new ProcessBuilder("reg", "query", key, "/v", value)
                    .redirectErrorStream(true).start();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            try (InputStream in = process.getInputStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) {
                    buffer.write(buf, 0, n);
                }
            }
            process.waitFor(5, TimeUnit.SECONDS);
            String text = buffer.toString(processCharset());
            int i = text.indexOf("REG_SZ");
            if (i < 0) {
                return null;
            }
            return text.substring(i + 6).trim();
        } catch (Exception e) {
            return null;
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    private static Charset processCharset() {
        try {
            String name = System.getProperty("sun.jnu.encoding");
            return name == null || name.isBlank() ? Charset.defaultCharset() : Charset.forName(name);
        } catch (RuntimeException e) {
            return Charset.defaultCharset();
        }
    }

    /** 给 CLI 用：打印候选。 */
    public static void print(List<DirInfo> list, Consumer<String> out) {
        out.accept("检测到 " + list.size() + " 个候选游戏目录：");
        for (DirInfo d : list) {
            out.accept("  " + d.label());
        }
    }
}
