package mcdl.ui;

import java.awt.Desktop;
import java.awt.Frame;
import java.awt.GraphicsEnvironment;
import java.awt.HeadlessException;
import java.io.File;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.InvocationTargetException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import javax.swing.JFileChooser;
import javax.swing.SwingUtilities;
import javax.swing.filechooser.FileNameExtensionFilter;

/**
 * 文件 / 文件夹选择与「用系统资源管理器打开目录」的纯 Java 实现。
 *
 * <p>不依赖随包分发的原生 helper、PowerShell 或 {@code Add-Type}：
 * 选择框统一使用 Swing 的 {@link JFileChooser}，打开目录优先 {@link Desktop#open(File)}，
 * 失败再退一次 {@code explorer.exe}。整个类只用到 JDK（{@code --release 17}），
 * 没有静态初始化块，类加载和无头（headless）环境下调用都不会抛异常。</p>
 *
 * <p>所有方法都可以在后台线程调用：{@code JFileChooser} 的显示会切到 EDT 并以阻塞方式
 * 等待用户操作，返回后调用方再回到自己的工作线程继续。用户取消返回 {@code null} 且不设置
 * {@link #lastError()}；真正的失败返回 {@code null/false} 并写入失败原因。</p>
 */
public final class NativeDialog {

    private NativeDialog() {
    }

    /** 最近一次失败原因（null 表示未失败；用户取消不算失败）。 */
    private static volatile String lastError;

    /** 最近一次失败原因（null 表示未失败；用户取消不算失败）。 */
    public static String lastError() {
        return lastError;
    }

    /**
     * 选择文件。
     *
     * <p>{@code filter} 兼容原来的 WinForms 风格（{@code 名称|模式|名称|模式}，可有多组），
     * 例如 {@code 整合包 (*.mrpack;*.zip)|*.mrpack;*.zip|所有文件 (*.*)|*.*}；也接受
     * 单个模式（{@code *.zip}）或单个描述。取第一组作为默认过滤器，其余组会作为可切换的
     * 过滤器加入。取消返回 null 且不设置 lastError；失败返回 null 并设置 lastError。</p>
     */
    public static File openFile(Frame owner, String title, String filter, String initialDir) {
        lastError = null;
        if (unavailable("文件")) {
            return null;
        }
        JFileChooser chooser;
        try {
            chooser = newChooser(title, JFileChooser.FILES_ONLY);
            applyFilter(chooser, filter);
            File dir = existingDir(initialDir);
            if (dir != null) {
                chooser.setCurrentDirectory(dir);
            }
        } catch (HeadlessException e) {
            lastError = "当前环境没有图形界面（headless），无法显示文件选择框";
            logFailure("open-file", lastError);
            return null;
        } catch (RuntimeException | Error e) {
            lastError = "初始化文件选择框失败：" + describe(e);
            logFailure("open-file", e);
            return null;
        }

        Integer option = ask(chooser, owner);
        if (option == null) {
            return null;
        }
        if (option != JFileChooser.APPROVE_OPTION) {
            lastError = null;
            return null;
        }
        File picked = chooser.getSelectedFile();
        if (picked == null) {
            lastError = "文件选择框没有返回任何路径";
            logFailure("open-file", lastError);
            return null;
        }
        if (!picked.isFile()) {
            lastError = "选择的路径不是文件：" + picked;
            logFailure("open-file", lastError);
            return null;
        }
        lastError = null;
        return picked;
    }

    /**
     * 选择文件夹（JFileChooser 的 {@code DIRECTORIES_ONLY} 模式）。
     * 取消返回 null 且不设置 lastError；失败返回 null 并设置 lastError。
     */
    public static File openFolder(Frame owner, String title, Path initial) {
        lastError = null;
        if (unavailable("文件夹")) {
            return null;
        }
        JFileChooser chooser;
        try {
            chooser = newChooser(title, JFileChooser.DIRECTORIES_ONLY);
            File dir = initial == null ? null : existingDir(initial.toString());
            if (dir != null) {
                chooser.setCurrentDirectory(dir);
            }
        } catch (HeadlessException e) {
            lastError = "当前环境没有图形界面（headless），无法显示文件夹选择框";
            logFailure("open-folder", lastError);
            return null;
        } catch (RuntimeException | Error e) {
            lastError = "初始化文件夹选择框失败：" + describe(e);
            logFailure("open-folder", e);
            return null;
        }

        Integer option = ask(chooser, owner);
        if (option == null) {
            return null;
        }
        if (option != JFileChooser.APPROVE_OPTION) {
            lastError = null;
            return null;
        }
        File picked = chooser.getSelectedFile();
        if (picked == null) {
            lastError = "文件夹选择框没有返回任何路径";
            logFailure("open-folder", lastError);
            return null;
        }
        if (!picked.isDirectory()) {
            lastError = "选择的路径不是目录：" + picked;
            logFailure("open-folder", lastError);
            return null;
        }
        lastError = null;
        return picked;
    }

    /**
     * 用系统文件管理器打开目录（纯 Java）。
     *
     * <p>先试 {@link Desktop#open(File)}（Windows 上走 ShellExecute，失败会抛异常）；
     * 不可用或抛异常时再退 {@code explorer.exe <路径>}。explorer.exe 无论成功与否通常都返回
     * 退出码 1，所以这里只在「启动失败 / 明显异常的退出码」时判负，并在 lastError 中说明。</p>
     */
    static boolean openWithHelper(Path dir) {
        lastError = null;
        if (dir == null) {
            lastError = "目录为空";
            return false;
        }
        Path abs;
        try {
            abs = dir.toAbsolutePath().normalize();
        } catch (RuntimeException e) {
            lastError = "目录不合法：" + dir;
            logFailure("open", lastError);
            return false;
        }
        if (!Files.isDirectory(abs)) {
            lastError = "目录不存在：" + abs;
            logFailure("open", lastError);
            return false;
        }

        String desktopError = openWithDesktop(abs);
        if (desktopError == null) {
            lastError = null;
            return true;
        }

        String shellError = openWithExplorer(abs);
        if (shellError == null) {
            lastError = null;
            return true;
        }

        lastError = "Desktop.open=" + desktopError + "；explorer=" + shellError;
        logFailure("open", lastError);
        return false;
    }

    //----------------------------------------------------------------------

    /** 无图形界面时的统一失败处理；返回 true 表示不可用。 */
    private static boolean unavailable(String what) {
        try {
            if (GraphicsEnvironment.isHeadless()) {
                lastError = "当前环境没有图形界面（headless），无法显示" + what + "选择框";
                logFailure(what, lastError);
                return true;
            }
        } catch (RuntimeException | Error e) {
            lastError = "无法判断图形环境：" + describe(e);
            logFailure(what, e);
            return true;
        }
        return false;
    }

    private static JFileChooser newChooser(String title, int mode) {
        JFileChooser chooser = new JFileChooser();
        chooser.setDialogTitle(title == null || title.isBlank() ? "选择" : title);
        chooser.setFileSelectionMode(mode);
        chooser.setMultiSelectionEnabled(false);
        chooser.setAcceptAllFileFilterUsed(true);
        return chooser;
    }

    /**
     * 解析 {@code 名称|模式|名称|模式} 形式的过滤器并加入选择框；第一组设为默认。
     * 无法识别的片段会被忽略，选择框始终保持「所有文件」可用，不会因为过滤器抛异常。
     */
    private static void applyFilter(JFileChooser chooser, String filter) {
        if (filter == null || filter.isBlank()) {
            return;
        }
        List<FileNameExtensionFilter> filters = new ArrayList<>();
        String[] parts = filter.split("\\|", -1);
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i].trim();
            if (part.isEmpty()) {
                continue;
            }
            String label;
            String spec;
            if (i + 1 < parts.length && !parts[i + 1].trim().isEmpty()) {
                label = part;
                spec = parts[i + 1].trim();
                i++;
            } else if (part.contains("*")) {
                label = "文件";
                spec = part;
            } else {
                label = part;
                spec = "";
            }
            List<String> extensions = extensions(spec);
            if (extensions.isEmpty()) {
                continue;
            }
            filters.add(new FileNameExtensionFilter(label, extensions.toArray(new String[0])));
        }
        for (FileNameExtensionFilter f : filters) {
            chooser.addChoosableFileFilter(f);
        }
        if (!filters.isEmpty()) {
            chooser.setFileFilter(filters.get(0));
        }
    }

    /** 把 {@code *.mrpack;*.zip} / {@code *.*} 之类的模式转成扩展名列表；通配全部返回空。 */
    private static List<String> extensions(String spec) {
        List<String> result = new ArrayList<>();
        if (spec == null || spec.isBlank()) {
            return result;
        }
        for (String raw : spec.split("[;,]")) {
            String s = raw.trim();
            if (s.isEmpty() || "*".equals(s) || "*.*".equals(s)) {
                continue;
            }
            if (s.startsWith("*.")) {
                s = s.substring(2);
            } else if (s.startsWith("*")) {
                // 形如 *.tar.gz 之外的特殊通配，交给「所有文件」处理
                continue;
            }
            if (!s.isEmpty() && s.chars().allMatch(c -> Character.isLetterOrDigit(c)
                    || c == '.' || c == '_' || c == '-')) {
                result.add(s);
            }
        }
        return result;
    }

    /** 返回存在的目录（不存在时向上找父目录）；无法解析返回 null。 */
    private static File existingDir(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            Path p = Path.of(raw.trim());
            if (!p.isAbsolute()) {
                p = p.toAbsolutePath();
            }
            while (p != null && !Files.isDirectory(p)) {
                p = p.getParent();
            }
            return p == null ? null : p.toFile();
        } catch (RuntimeException e) {
            return null;
        }
    }

    /**
     * 在 EDT 上以模态方式显示选择框并等待结果。
     * 返回 {@link JFileChooser#APPROVE_OPTION} / {@link JFileChooser#CANCEL_OPTION}，
     * 显示失败返回 null（并写入 lastError）。
     */
    private static Integer ask(JFileChooser chooser, Frame owner) {
        if (SwingUtilities.isEventDispatchThread()) {
            try {
                return chooser.showOpenDialog(owner);
            } catch (RuntimeException | Error e) {
                lastError = "显示选择框失败：" + describe(e);
                logFailure("show", e);
                return null;
            }
        }
        final AtomicReference<Integer> result = new AtomicReference<>();
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        try {
            SwingUtilities.invokeAndWait(() -> {
                try {
                    result.set(chooser.showOpenDialog(owner));
                } catch (Throwable t) {
                    failure.set(t);
                }
            });
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            lastError = "等待选择框时被中断";
            logFailure("show", lastError);
            return null;
        } catch (InvocationTargetException e) {
            failure.set(e.getCause() == null ? e : e.getCause());
        } catch (RuntimeException | Error e) {
            failure.set(e);
        }
        if (failure.get() != null) {
            lastError = "显示选择框失败：" + describe(failure.get());
            logFailure("show", failure.get());
            return null;
        }
        Integer option = result.get();
        if (option == null) {
            lastError = "选择框没有返回结果";
            logFailure("show", lastError);
            return null;
        }
        return option;
    }

    /** 成功返回 null，失败返回原因。 */
    private static String openWithDesktop(Path dir) {
        try {
            if (GraphicsEnvironment.isHeadless()) {
                return "无图形界面（headless）";
            }
            if (!Desktop.isDesktopSupported()) {
                return "当前环境不支持 Desktop";
            }
            Desktop desktop = Desktop.getDesktop();
            if (!desktop.isSupported(Desktop.Action.OPEN)) {
                return "当前环境不支持 Desktop.open";
            }
            desktop.open(dir.toFile());
            return null;
        } catch (HeadlessException e) {
            return "无图形界面（headless）";
        } catch (IOException | RuntimeException | Error e) {
            return describe(e);
        }
    }

    /** 成功启动返回 null，失败返回原因。 */
    private static String openWithExplorer(Path dir) {
        Process process = null;
        try {
            process = new ProcessBuilder("explorer.exe", dir.toString())
                    .redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start();
            // explorer.exe 成功时通常也返回 1；只有「很快退出且退出码不是 0/1」才算失败。
            if (process.waitFor(1200, TimeUnit.MILLISECONDS)) {
                int code = process.exitValue();
                if (code != 0 && code != 1) {
                    return "explorer.exe 退出码 " + code;
                }
            }
            return null;
        } catch (IOException e) {
            return "无法启动 explorer.exe：" + describe(e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "等待 explorer.exe 时被中断";
        } catch (RuntimeException | Error e) {
            return "无法启动 explorer.exe：" + describe(e);
        } finally {
            if (process != null && process.isAlive()) {
                process.destroy();
            }
        }
    }

    private static String describe(Throwable t) {
        if (t == null) {
            return "未知错误";
        }
        String m = t.getMessage();
        return t.getClass().getSimpleName() + (m == null || m.isBlank() ? "" : "：" + m);
    }

    /** 失败诊断：写到 %USERPROFILE%\.mcdl\dialog-error.log（追加），便于用户反馈。 */
    private static void logFailure(String stage, Object detail) {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append(java.time.OffsetDateTime.now()).append(" [").append(stage).append("] ")
                    .append(detail).append('\n');
            sb.append("java=").append(System.getProperty("java.home")).append('\n');
            if (detail instanceof Throwable t) {
                StringWriter sw = new StringWriter();
                t.printStackTrace(new PrintWriter(sw));
                sb.append(sw).append('\n');
            }
            String home = System.getProperty("user.home");
            if (home == null || home.isBlank()) {
                return;
            }
            Path dir = Path.of(home, ".mcdl");
            Files.createDirectories(dir);
            Files.writeString(dir.resolve("dialog-error.log"), sb.toString(), StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (Exception ignored) {
            // 诊断日志写不进去不影响主流程
        }
    }
}
