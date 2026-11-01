package mcdl.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 扫描本机已安装的 Java。
 *
 * <p>来源覆盖（与 PCL2 / HMCL 的 Java 列表思路一致）：</p>
 * <ol>
 *   <li>环境变量 {@code JAVA_HOME} 与 {@code PATH}</li>
 *   <li>Windows 注册表（JavaSoft / Adoptium / Microsoft / Zulu / Corretto 等）</li>
 *   <li>常见安装目录（Program Files 下各家 JDK、LOCALAPPDATA 下的 Adoptium）</li>
 *   <li>启动器自带的运行时（Mojang {@code .minecraft/runtime}、HMCL {@code .hmcl/java}）</li>
 * </ol>
 *
 * <p>版本优先从 {@code <home>/release} 文件读取（快、无副作用），没有该文件时才执行
 * {@code java -version} 兜底；{@link #verify(JavaInfo)} 会真正跑一次 {@code -version}
 * 来确认这个 Java 可用（也就是「核实」）。</p>
 */
public final class JavaFinder {

    private JavaFinder() {
    }

    /** 一个可用的 Java。 */
    public static final class JavaInfo {
        public final Path home;
        public final Path exe;
        public final String version;
        public final int major;
        public final String arch;
        public final String vendor;
        public final String source;
        /** 是否真正执行过 java -version 并成功。 */
        public boolean verified;
        /** 执行 -version 失败（文件在但跑不起来）。 */
        public boolean broken;

        JavaInfo(Path home, Path exe, String version, int major, String arch,
                 String vendor, String source) {
            this.home = home;
            this.exe = exe;
            this.version = version == null ? "" : version;
            this.major = major;
            this.arch = arch == null || arch.isEmpty() ? "?" : arch;
            this.vendor = vendor == null || vendor.isEmpty() ? "未知" : vendor;
            this.source = source;
        }

        /** "Java 17 · Temurin · x64" */
        public String label() {
            return "Java " + (major > 0 ? major : "?") + " · " + vendor + " · " + arch;
        }

        /** 下拉框里用的短标签：Java 25 · Temurin · x64（jdk-25.0.4.101） */
        public String comboLabel() {
            String folder = home == null || home.getFileName() == null ? "" : home.getFileName().toString();
            return label() + (folder.isEmpty() ? "" : "（" + folder + "）");
        }

        /** 带路径的一行描述。 */
        public String describe() {
            return label() + " — " + exe;
        }

        public boolean satisfies(int required) {
            return required <= 0 || major >= required;
        }

        public boolean exact(int required) {
            return required > 0 && major == required;
        }

        @Override
        public String toString() {
            return describe();
        }
    }

    private static final class Candidate {
        final Path exe;
        final String source;

        Candidate(Path exe, String source) {
            this.exe = exe;
            this.source = source;
        }
    }

    /** 扫描（不执行 Java，速度快）。结果按主版本号从高到低排序。 */
    public static List<JavaInfo> scan() {
        Map<String, Candidate> candidates = new LinkedHashMap<>();
        if (isWindows()) {
            String javaHome = System.getenv("JAVA_HOME");
            if (javaHome != null && !javaHome.isBlank()) {
                addHome(Paths.get(javaHome), "JAVA_HOME", candidates);
            }
            String path = System.getenv("PATH");
            if (path != null) {
                for (String part : path.split(";")) {
                    if (part.isBlank()) {
                        continue;
                    }
                    Path dir = Paths.get(part.trim());
                    addExe(dir.resolve("java.exe"), "PATH", candidates);
                    addExe(dir.resolve("bin").resolve("java.exe"), "PATH", candidates);
                }
            }
            debug("after path: " + candidates.size());
            registryCandidates(candidates);
            debug("after registry: " + candidates.size());
            commonDirs(candidates);
            debug("after dirs: " + candidates.size());
            launcherRuntimes(candidates);
            debug("after launchers: " + candidates.size());
        } else {
            String javaHome = System.getenv("JAVA_HOME");
            if (javaHome != null && !javaHome.isBlank()) {
                addHome(Paths.get(javaHome), "JAVA_HOME", candidates);
            }
            for (String part : System.getenv().getOrDefault("PATH", "/usr/bin:/bin").split(":")) {
                if (!part.isBlank()) {
                    addExe(Paths.get(part, "java"), "PATH", candidates);
                }
            }
            for (String p : new String[]{"/usr/lib/jvm", "/Library/Java/JavaVirtualMachines"}) {
                listSubdirs(Paths.get(p), 3, "目录", candidates);
            }
        }

        debug("scan candidates: " + candidates.size());
        Map<String, JavaInfo> byRealPath = new LinkedHashMap<>();
        for (Candidate c : candidates.values()) {
            JavaInfo info = read(c.exe, c.source);
            if (info == null) {
                continue;
            }
            String key = realPath(info.exe);
            byRealPath.putIfAbsent(key, info);
        }
        List<JavaInfo> out = new ArrayList<>(byRealPath.values());
        out.sort(Comparator
                .comparingInt((JavaInfo j) -> j.major).reversed()
                .thenComparing(j -> "x64".equals(j.arch) ? 0 : 1)
                .thenComparing(j -> j.exe.toString()));
        return out;
    }

    /** 真正执行一次 java -version，确认这个 Java 可用。 */
    public static boolean verify(JavaInfo info) {
        String out = exec(info.exe.toString(), "-version");
        if (out.isEmpty()) {
            info.broken = true;
            info.verified = false;
            return false;
        }
        info.broken = false;
        info.verified = true;
        return true;
    }

    /**
     * 选出最合适的 Java：优先主版本号完全一致的；没有再选「比要求更高里最小的」；
     * 都没有就退回本机最高版本（并会在提示里标明不满足）。
     */
    public static JavaInfo best(List<JavaInfo> list, int requiredMajor) {
        List<JavaInfo> usable = new ArrayList<>();
        for (JavaInfo j : list) {
            if (!j.broken) {
                usable.add(j);
            }
        }
        if (usable.isEmpty()) {
            return null;
        }
        if (requiredMajor > 0) {
            JavaInfo exact = pick(usable, true, requiredMajor);
            if (exact != null) {
                return exact;
            }
            JavaInfo higher = null;
            for (JavaInfo j : usable) {
                if (j.major > requiredMajor && (higher == null || j.major < higher.major)) {
                    higher = j;
                }
            }
            if (higher != null) {
                return higher;
            }
        }
        return usable.get(0);
    }

    private static JavaInfo pick(List<JavaInfo> list, boolean exact, int major) {
        JavaInfo best = null;
        for (JavaInfo j : list) {
            boolean match = exact ? j.major == major : j.major >= major;
            if (!match) {
                continue;
            }
            if (best == null || score(j) > score(best)) {
                best = j;
            }
        }
        return best;
    }

    private static int score(JavaInfo j) {
        int s = 0;
        if (j.verified) {
            s += 4;
        }
        if ("x64".equals(j.arch)) {
            s += 2;
        }
        if (j.exe.toString().toLowerCase(Locale.ROOT).contains("jdk")) {
            s += 1;
        }
        return s;
    }

    /** "8/17/25"（去重、升序） */
    public static String summary(List<JavaInfo> list) {
        if (list.isEmpty()) {
            return "无";
        }
        java.util.TreeSet<Integer> majors = new java.util.TreeSet<>();
        for (JavaInfo j : list) {
            if (j.major > 0) {
                majors.add(j.major);
            }
        }
        StringBuilder sb = new StringBuilder();
        for (Integer m : majors) {
            if (sb.length() > 0) {
                sb.append('/');
            }
            sb.append(m);
        }
        return sb.length() == 0 ? "?" : sb.toString();
    }

    /** 说明某个 Java 与版本要求的关系。 */
    public static String matchLabel(JavaInfo info, int required) {
        if (info == null) {
            return "未找到";
        }
        if (required <= 0) {
            return "自动选择";
        }
        if (info.major == required) {
            return "完全匹配";
        }
        if (info.major > required) {
            return "高于要求（一般可用）";
        }
        return "低于要求（不建议）";
    }

    /** 把用户手填的路径（java.exe 或 home 目录）解析成 JavaInfo。 */
    public static JavaInfo ofPath(Path path) {
        if (path == null) {
            return null;
        }
        Path exe = path;
        if (Files.isDirectory(path)) {
            Path bin = path.resolve("bin").resolve(isWindows() ? "java.exe" : "java");
            if (Files.isRegularFile(bin)) {
                exe = bin;
            } else if (Files.isRegularFile(path.resolve(isWindows() ? "java.exe" : "java"))) {
                exe = path.resolve(isWindows() ? "java.exe" : "java");
            } else {
                return null;
            }
        } else if (!Files.isRegularFile(path)) {
            return null;
        }
        return read(exe, "手动指定");
    }

    private static JavaInfo read(Path exe, String source) {
        if (exe == null || !Files.isRegularFile(exe)) {
            return null;
        }
        Path home = exe.getParent();
        if (home != null && home.getFileName() != null
                && "bin".equalsIgnoreCase(home.getFileName().toString())) {
            home = home.getParent();
        }
        if (home == null) {
            home = exe.getParent();
        }
        long t0 = System.nanoTime();
        String version = null;
        String arch = null;
        String vendor = null;
        Path release = home == null ? null : home.resolve("release");
        if (release != null && Files.isRegularFile(release)) {
            Properties props = new Properties();
            try (InputStream in = Files.newInputStream(release)) {
                props.load(in);
            } catch (IOException ignored) {
                // release 读不了就退回执行 -version
            }
            version = unquote(props.getProperty("JAVA_VERSION"));
            arch = normalizeArch(unquote(props.getProperty("OS_ARCH")));
            vendor = vendorOf(unquote(props.getProperty("IMPLEMENTOR")), home);
        }
        if (version == null || version.isBlank() || arch == null) {
            String out = exec(exe.toString(), "-version");
            if (version == null || version.isBlank()) {
                Matcher m = Pattern.compile("version \"([^\"]+)\"").matcher(out);
                if (m.find()) {
                    version = m.group(1);
                }
            }
            if (arch == null) {
                Matcher a = Pattern.compile("(?i)(\\d+)-bit").matcher(out);
                if (a.find()) {
                    arch = "32".equals(a.group(1)) ? "x86" : "x64";
                }
            }
        }
        if (version == null || version.isBlank()) {
            return null;
        }
        debug("read " + exe + " -> " + version + " (" + ((System.nanoTime() - t0) / 1_000_000L) + " ms)");
        int major = majorOf(version);
        return new JavaInfo(home, exe, version, major, arch, vendor, source);
    }

    private static String vendorOf(String implementor, Path home) {
        String text = ((implementor == null ? "" : implementor) + " "
                + (home == null ? "" : home.toString())).toLowerCase(Locale.ROOT);
        if (text.contains("temurin") || text.contains("adoptium")) {
            return "Temurin";
        }
        if (text.contains("microsoft")) {
            return "Microsoft";
        }
        if (text.contains("zulu") || text.contains("azul")) {
            return "Zulu";
        }
        if (text.contains("corretto") || text.contains("amazon")) {
            return "Corretto";
        }
        if (text.contains("semeru") || text.contains("ibm")) {
            return "Semeru";
        }
        if (text.contains("graal")) {
            return "GraalVM";
        }
        if (text.contains("oracle")) {
            return "Oracle";
        }
        if (text.contains("openjdk")) {
            return "OpenJDK";
        }
        if (text.contains("\\java\\jdk") || text.contains("\\java\\jre")
                || text.contains("\\java\\jdk-") || text.contains("java\\jre")) {
            return "Oracle";
        }
        if (implementor != null && !implementor.isBlank()) {
            return implementor;
        }
        return null;
    }

    private static String normalizeArch(String arch) {
        if (arch == null) {
            return null;
        }
        String a = arch.toLowerCase(Locale.ROOT);
        if (a.contains("aarch64") || a.contains("arm64")) {
            return "arm64";
        }
        if (a.contains("64")) {
            return "x64";
        }
        if (a.contains("86") || a.contains("i386") || a.contains("i686")) {
            return "x86";
        }
        return arch;
    }

    /** "1.8.0_402" → 8，"17.0.11" → 17。 */
    public static int majorOf(String version) {
        if (version == null) {
            return -1;
        }
        String s = unquote(version.trim());
        if (s.startsWith("1.")) {
            String[] parts = s.split("\\.");
            if (parts.length > 1) {
                return parseInt(parts[1]);
            }
            return -1;
        }
        int i = 0;
        while (i < s.length() && Character.isDigit(s.charAt(i))) {
            i++;
        }
        return i == 0 ? -1 : parseInt(s.substring(0, i));
    }

    /** release 文件里的值是带引号的（JAVA_VERSION="17.0.11"），去掉引号。 */
    private static String unquote(String s) {
        if (s == null) {
            return null;
        }
        String v = s.trim();
        if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
            v = v.substring(1, v.length() - 1);
        }
        return v;
    }

    private static int parseInt(String s) {
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static void addExe(Path exe, String source, Map<String, Candidate> out) {
        if (exe == null) {
            return;
        }
        try {
            if (!Files.isRegularFile(exe)) {
                return;
            }
            String key = realPath(exe).toLowerCase(Locale.ROOT);
            out.putIfAbsent(key, new Candidate(exe, source));
        } catch (RuntimeException ignored) {
            // 路径非法时跳过
        }
    }

    private static void addHome(Path home, String source, Map<String, Candidate> out) {
        if (home == null) {
            return;
        }
        addExe(home.resolve("bin").resolve(isWindows() ? "java.exe" : "java"), source, out);
    }

    private static String realPath(Path p) {
        try {
            return p.toRealPath().toString();
        } catch (IOException e) {
            return p.toAbsolutePath().normalize().toString();
        }
    }

    private static void registryCandidates(Map<String, Candidate> out) {
        String[] roots = {
                "HKLM\\SOFTWARE\\JavaSoft",
                "HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft",
                "HKLM\\SOFTWARE\\Eclipse Adoptium",
                "HKLM\\SOFTWARE\\Microsoft\\JDK",
                "HKLM\\SOFTWARE\\Azul Systems",
                "HKLM\\SOFTWARE\\Amazon Corretto",
                "HKLM\\SOFTWARE\\BellSoft",
                "HKLM\\SOFTWARE\\SapMachine",
                "HKLM\\SOFTWARE\\Semeru"
        };
        for (String root : roots) {
            String text = exec("reg", "query", root, "/s");
            if (text.isEmpty()) {
                continue;
            }
            for (String line : text.split("\\R")) {
                int i = line.indexOf("REG_SZ");
                if (i < 0) {
                    i = line.indexOf("REG_EXPAND_SZ");
                }
                if (i < 0) {
                    continue;
                }
                String value = line.substring(i + (line.startsWith("REG_EXPAND_SZ", i) ? 13 : 6)).trim();
                if (value.isEmpty()) {
                    continue;
                }
                Path dir;
                try {
                    dir = Paths.get(value);
                } catch (RuntimeException e) {
                    continue;
                }
                if (!Files.isDirectory(dir)) {
                    continue;
                }
                addHome(dir, "注册表", out);
                addExe(dir.resolve("bin").resolve("java.exe"), "注册表", out);
            }
        }
    }

    private static void commonDirs(Map<String, Candidate> out) {
        List<Path> roots = new ArrayList<>();
        addRoot(roots, System.getenv("ProgramFiles"), "Java");
        addRoot(roots, System.getenv("ProgramFiles"), "Eclipse Adoptium");
        addRoot(roots, System.getenv("ProgramFiles"), "Microsoft");
        addRoot(roots, System.getenv("ProgramFiles"), "Amazon Corretto");
        addRoot(roots, System.getenv("ProgramFiles"), "Zulu");
        addRoot(roots, System.getenv("ProgramFiles"), "BellSoft");
        addRoot(roots, System.getenv("ProgramFiles"), "Semeru");
        addRoot(roots, System.getenv("ProgramFiles"), "RedHat");
        addRoot(roots, System.getenv("ProgramFiles(x86)"), "Java");
        addRoot(roots, System.getenv("ProgramFiles(x86)"), "Eclipse Adoptium");
        addRoot(roots, System.getenv("LOCALAPPDATA"), "Programs\\Eclipse Adoptium");
        // 只枚举两层：<root>\<jdk>\bin 与 <root>\<jdk>\<jre>\bin。
        // 不用 Files.walk 是因为 Program Files\Microsoft 这类目录可能有几十万文件。
        for (Path root : roots) {
            for (Path child : dirs(root)) {
                addHome(child, "目录", out);
                for (Path grand : dirs(child)) {
                    addHome(grand, "目录", out);
                }
            }
        }
    }

    private static List<Path> dirs(Path dir) {
        List<Path> result = new ArrayList<>();
        if (dir == null || !Files.isDirectory(dir)) {
            return result;
        }
        try (java.nio.file.DirectoryStream<Path> ds = Files.newDirectoryStream(dir)) {
            for (Path p : ds) {
                if (Files.isDirectory(p)) {
                    result.add(p);
                }
            }
        } catch (IOException | RuntimeException ignored) {
            // 权限不足或目录消失
        }
        return result;
    }

    private static void launcherRuntimes(Map<String, Candidate> out) {
        String appData = System.getenv("APPDATA");
        if (appData != null) {
            listSubdirs(Paths.get(appData, ".minecraft", "runtime"), 5, "Mojang 运行时", out);
            listSubdirs(Paths.get(appData, ".hmcl", "java"), 4, "HMCL", out);
        }
        String userHome = System.getProperty("user.home");
        if (userHome != null) {
            listSubdirs(Paths.get(userHome, ".hmcl", "java"), 4, "HMCL", out);
            listSubdirs(Paths.get(userHome, ".minecraft", "runtime"), 5, "Mojang 运行时", out);
        }
    }

    private static void addRoot(List<Path> roots, String base, String child) {
        if (base == null || base.isBlank()) {
            return;
        }
        Path p = Paths.get(base, child);
        if (Files.isDirectory(p)) {
            roots.add(p);
        }
    }

    /** 在 dir 下搜深度不超过 maxDepth 的 bin/java.exe。 */
    private static void listSubdirs(Path dir, int maxDepth, String source, Map<String, Candidate> out) {
        if (dir == null || !Files.isDirectory(dir)) {
            return;
        }
        final int limit = 400;
        final int[] count = {0};
        try (var stream = Files.walk(dir, maxDepth)) {
            stream.limit(limit).filter(p -> {
                Path name = p.getFileName();
                if (name == null || !"bin".equalsIgnoreCase(name.toString())) {
                    return false;
                }
                Path parent = p.getParent();
                return parent != null;
            }).forEach(bin -> addExe(bin.resolve("java.exe"), source, out));
        } catch (IOException | RuntimeException ignored) {
            // 没有权限或目录在扫描时被删除都跳过
        }
    }

    private static String exec(String... command) {
        Process process = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(command).redirectErrorStream(true);
            process = pb.start();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            try (InputStream in = process.getInputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    buffer.write(buf, 0, n);
                    if (buffer.size() > 256 * 1024) {
                        break;
                    }
                }
            }
            process.waitFor(6, TimeUnit.SECONDS);
            return new String(buffer.toByteArray(), processCharset());
        } catch (Exception e) {
            return "";
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    private static Charset processCharset() {
        String name = System.getProperty("sun.jnu.encoding");
        try {
            return name == null || name.isBlank() ? Charset.defaultCharset() : Charset.forName(name);
        } catch (RuntimeException e) {
            return Charset.defaultCharset();
        }
    }

    private static void debug(String message) {
        if (System.getProperty("mcdl.debugJava") != null) {
            System.err.println("[JavaFinder] " + message);
        }
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    /** 给 GUI / CLI 用的一次性汇总。 */
    public static void print(List<JavaInfo> list, Consumer<String> out) {
        out.accept("找到 " + list.size() + " 个 Java：");
        for (JavaInfo j : list) {
            out.accept(String.format(Locale.ROOT, "  %-38s %-10s %-8s %s %s",
                    j.label(), j.major > 0 ? j.version : "?",
                    j.verified ? "已核实" : (j.broken ? "不可用" : "未核实"),
                    j.exe, "[" + j.source + "]"));
        }
    }
}
