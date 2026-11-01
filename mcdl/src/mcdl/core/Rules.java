package mcdl.core;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Minecraft 版本 JSON 中 {@code rules} 的判定。
 *
 * <p>规则是「最后一条匹配的规则说了算」：按顺序遍历，凡是匹配当前环境的规则就把
 * allowed 置为它的 action；没有 rules 字段时默认为允许。</p>
 *
 * <p>支持 os.name（windows/osx/linux）、os.arch（x86/x64/arm64）、os.version（正则）、
 * 以及 features（下载阶段一律视为 false，因此带 features 的规则不匹配）。</p>
 */
public final class Rules {

    private Rules() {
    }

    public static String osName() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        if (os.contains("win")) {
            return "windows";
        }
        if (os.contains("mac") || os.contains("darwin")) {
            return "osx";
        }
        return "linux";
    }

    public static String osArch() {
        String arch = System.getProperty("os.arch", "").toLowerCase(Locale.ROOT);
        if (arch.equals("x86") || arch.equals("i386") || arch.equals("i686")) {
            return "x86";
        }
        if (arch.equals("aarch64") || arch.equals("arm64")) {
            return "arm64";
        }
        return "x64";
    }

    public static String osVersion() {
        return System.getProperty("os.version", "");
    }

    /** 判定一组规则是否允许当前环境。rules 可以为 null。 */
    public static boolean allowed(Json.Value rules) {
        if (rules == null || rules.isNull() || !rules.isArray() || rules.size() == 0) {
            return true;
        }
        boolean allowed = false;
        for (Json.Value rule : rules.asList()) {
            if (matches(rule)) {
                allowed = "allow".equals(rule.opt("action").asString(""));
            }
        }
        return allowed;
    }

    private static boolean matches(Json.Value rule) {
        Json.Value features = rule.get("features");
        if (features != null && features.isObject() && features.size() > 0) {
            // 下载时没有「自定义分辨率 / 演示用户」这类特性，任何 features 规则都不匹配
            return false;
        }
        Json.Value os = rule.get("os");
        if (os == null || os.isNull()) {
            return true;
        }
        String name = os.opt("name").asString("");
        if (!name.isEmpty() && !name.equals(osName())) {
            return false;
        }
        String arch = os.opt("arch").asString("");
        if (!arch.isEmpty() && !arch.equals(osArch())) {
            return false;
        }
        String version = os.opt("version").asString("");
        if (!version.isEmpty()) {
            try {
                if (!Pattern.compile(version).matcher(osVersion()).find()) {
                    return false;
                }
            } catch (RuntimeException e) {
                // 正则写错时保守放行，避免因为一条规则导致整个安装失败
                return true;
            }
        }
        return true;
    }

    /** 旧版 natives 映射里 os 名 → 键（windows → natives-windows）。 */
    public static String nativesKey(Json.Value natives) {
        if (natives == null || !natives.isObject()) {
            return null;
        }
        String key = natives.opt(osName()).asString("");
        if (!key.isEmpty()) {
            return key;
        }
        // 32 位 Windows 老版本会写 natives-windows-32 / natives-windows-64
        if ("windows".equals(osName())) {
            String k = natives.opt("windows-" + ("x86".equals(osArch()) ? "32" : "64")).asString("");
            if (!k.isEmpty()) {
                return k;
            }
        }
        return null;
    }
}
