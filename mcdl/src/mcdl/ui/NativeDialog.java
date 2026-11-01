package mcdl.ui;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Base64;
import java.util.concurrent.TimeUnit;

/**
 * Windows 原生文件 / 文件夹选择框。
 *
 * <p>用 {@code IFileOpenDialog}（Vista 起的通用文件对话框）实现，外观与资源管理器一致：
 * 文件夹选择走 {@code FOS_PICKFOLDERS}，文件选择带类型过滤。对话框以 MCDL 主窗口为 owner，
 * 并在出现后主动置前，关闭后不会影响其他程序。</p>
 *
 * <p>实现方式：把一段 C# COM 互操作代码和调用脚本通过 PowerShell 的 {@code -EncodedCommand}
 * 直接传入（不落地任何 .ps1/.cs 临时文件），用 {@code -STA} 执行，结果以
 * {@code OK:<路径>} / {@code CANCEL} / {@code ERR:<原因>} 的形式回传。这样既不会被
 * 安全软件当作文本脚本删除，也没有临时文件清理问题；只有编码命令被拦截时才退回一次
 * 临时 .ps1 的方式。</p>
 */
public final class NativeDialog {

    private NativeDialog() {
    }

    private static String lastError;

    /** 当前正在显示的对话框进程；退出时销毁，避免留下孤儿模态框。 */
    private static volatile Process currentDialog;

    static {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            Process p = currentDialog;
            if (p != null && p.isAlive()) {
                p.destroyForcibly();
            }
        }, "mcdl-dialog-cleanup"));
    }

    /** 最近一次失败原因（null 表示未失败；用户取消不算失败）。 */
    public static String lastError() {
        return lastError;
    }

    /**
     * 选择文件。{@code filter} 为 WinForms 风格（{@code 名称|模式|名称|模式}），只取第一组。
     * 取消返回 null 且不设置 lastError；失败返回 null 并设置 lastError。
     */
    public static File openFile(java.awt.Frame owner, String title, String filter, String initialDir) {
        lastError = null;
        String label = "文件";
        String spec = "*.*";
        if (filter != null && !filter.isBlank()) {
            String[] parts = filter.split("\\|");
            if (parts.length >= 2) {
                label = parts[0].trim();
                spec = parts[1].trim();
            } else {
                spec = filter.trim();
            }
        }
        String out = run("PickFile", title, initialDir == null ? "" : initialDir,
                label, spec, owner);
        return parse(out, false);
    }

    /** 选择文件夹；取消返回 null 且不设置 lastError。 */
    public static File openFolder(java.awt.Frame owner, String title, Path initial) {
        lastError = null;
        String out = run("PickFolder", title, initial == null ? "" : initial.toString(),
                "", "", owner);
        return parse(out, true);
    }

    /** 让原生 helper 用 ShellExecuteEx 打开目录；成功返回 true，失败时 lastError 有原因。 */
    static boolean openWithHelper(Path dir) {
        Path helper = helperPath();
        if (helper == null || dir == null) {
            return false;
        }
        Process process = null;
        try {
            Path workDir = Path.of(System.getProperty("user.home"), ".mcdl");
            Files.createDirectories(workDir);
            ProcessBuilder pb = new ProcessBuilder(helper.toString(), "open", b64(dir.toString()));
            pb.directory(workDir.toFile());
            pb.redirectErrorStream(true);
            process = pb.start();

            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            Process proc = process;
            Thread reader = new Thread(() -> {
                try (InputStream in = proc.getInputStream()) {
                    in.transferTo(buf);
                } catch (IOException ignored) {
                    // 忽略
                }
            }, "mcdl-open-helper-out");
            reader.setDaemon(true);
            reader.start();

            if (!process.waitFor(20, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                lastError = "打开目录超时未响应";
                logFailure("open", lastError);
                return false;
            }
            reader.join(2000);
            String text = buf.toString(StandardCharsets.UTF_8).trim();
            if ("OK".equals(text)) {
                return true;
            }
            lastError = text.isEmpty() ? "helper 没有返回结果" : text;
            logFailure("open", lastError);
            return false;
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            logFailure("open", e);
            lastError = "无法调用系统文件管理器：" + describe(e);
            return false;
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    //----------------------------------------------------------------------

    private static String run(String method, String title, String initial,
                              String filterLabel, String filterSpec, java.awt.Frame owner) {
        // 首选随包发布的原生 helper：不依赖 PowerShell / Add-Type / 临时目录
        Path helper = helperPath();
        if (helper != null) {
            String out = execHelper(helper, method, title, initial, filterLabel, filterSpec, owner);
            if (out != null) {
                return out;
            }
            logFailure("helper", lastError);
            lastError = null;
        }

        String script = buildScript(method, title, initial, filterLabel, filterSpec, owner);

        String encoded = Base64.getEncoder()
                .encodeToString(script.getBytes(StandardCharsets.UTF_16LE));
        // Windows 命令行上限 32767；正常脚本约 27 KB，留出余量
        if (encoded.length() <= 30000) {
            String out = exec(commandEncoded(encoded), "encoded");
            if (out != null || lastError == null) {
                return out;
            }
            // 编码命令没有跑起来（少数安全软件会拦 -EncodedCommand），退回脚本文件再试一次
            logFailure("encoded", lastError);
            lastError = null;
        }
        return runViaScriptFile(script);
    }

    /** 随 jar 一起发布的 McdlDialog.exe（同目录，或上一级目录）。 */
    private static Path helperPath() {
        try {
            var source = NativeDialog.class.getProtectionDomain().getCodeSource();
            if (source != null && source.getLocation() != null) {
                Path location = Path.of(source.getLocation().toURI());
                Path dir = Files.isDirectory(location) ? location : location.getParent();
                for (int i = 0; i < 2 && dir != null; i++) {
                    Path exe = dir.resolve("McdlDialog.exe");
                    if (Files.isRegularFile(exe)) {
                        return exe;
                    }
                    dir = dir.getParent();
                }
            }
        } catch (Exception ignored) {
            // 取不到 code source 时继续用工作目录探测
        }
        try {
            Path cwd = Path.of(System.getProperty("user.dir"), "McdlDialog.exe");
            if (Files.isRegularFile(cwd)) {
                return cwd;
            }
        } catch (Exception ignored) {
            // 忽略
        }
        return null;
    }

    /** 调用内置 helper，结果通过 stdout 回传（不写临时文件）。 */
    private static String execHelper(Path helper, String method, String title, String initial,
                                     String filterLabel, String filterSpec, java.awt.Frame owner) {
        Process process = null;
        try {
            Path workDir = Path.of(System.getProperty("user.home"), ".mcdl");
            Files.createDirectories(workDir);
            String mode = "PickFolder".equals(method) ? "folder" : "file";
            ProcessBuilder pb = new ProcessBuilder(
                    helper.toString(), mode,
                    b64(title), b64(initial), b64(filterLabel), b64(filterSpec),
                    Long.toString(ProcessHandle.current().pid()),
                    b64(owner == null ? "" : String.valueOf(owner.getTitle())));
            pb.directory(workDir.toFile());
            pb.redirectErrorStream(true);
            process = pb.start();
            currentDialog = process;

            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            Process proc = process;
            Thread reader = new Thread(() -> {
                try (InputStream in = proc.getInputStream()) {
                    in.transferTo(buf);
                } catch (IOException ignored) {
                    // 进程被销毁时读取会中断，忽略
                }
            }, "mcdl-dialog-helper-out");
            reader.setDaemon(true);
            reader.start();

            if (!process.waitFor(15, TimeUnit.MINUTES)) {
                process.destroyForcibly();
                process.waitFor(3, TimeUnit.SECONDS);
                lastError = "文件对话框超时未响应";
                logFailure("helper", lastError);
                return null;
            }
            reader.join(3000);
            String text = buf.toString(StandardCharsets.UTF_8).trim();
            if (text.isEmpty()) {
                lastError = "原生对话框没有返回结果（退出码 " + process.exitValue() + "）";
                logFailure("helper", lastError);
                return null;
            }
            return text;
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            logFailure("helper", e);
            lastError = "无法启动系统文件对话框：" + describe(e);
            return null;
        } finally {
            if (process != null && currentDialog == process) {
                currentDialog = null;
                if (process.isAlive()) {
                    process.destroyForcibly();
                }
            }
        }
    }

    private static String b64(String s) {
        return Base64.getEncoder().encodeToString(
                (s == null ? "" : s).getBytes(StandardCharsets.UTF_8));
    }

    private static String buildScript(String method, String title, String initial,
                                      String filterLabel, String filterSpec, java.awt.Frame owner) {
        long pid = ProcessHandle.current().pid();
        String windowTitle = owner == null ? "" : String.valueOf(owner.getTitle());
        StringBuilder call = new StringBuilder();
        call.append('$').append("r = [McdlDialog]::").append(method).append('(')
                .append(ps(title)).append(',')
                .append(ps(initial)).append(',');
        if ("PickFile".equals(method)) {
            call.append(ps(filterLabel)).append(',')
                    .append(ps(filterSpec)).append(',');
        }
        call.append(pid).append(',')
                .append(ps(windowTitle)).append(")");

        String cs = CS_DIALOG.replace("\r\n", "\n");
        if (!cs.endsWith("\n")) {
            cs = cs + "\n";
        }
        cs = cs.replace("\n", "\r\n");

        return "$ErrorActionPreference='Stop'\r\n"
                + "[Console]::OutputEncoding=[Text.Encoding]::UTF8\r\n"
                + "try {\r\n"
                + "  $code = @'\r\n"
                + cs
                + "'@\r\n"
                + "  Add-Type -TypeDefinition $code -Language CSharp\r\n"
                + "  " + call + "\r\n"
                + "  if ($null -eq $r) { Write-Output 'CANCEL' } else { Write-Output ('OK:' + $r) }\r\n"
                + "} catch {\r\n"
                + "  Write-Output ('ERR:' + $_.Exception.Message)\r\n"
                + "}\r\n";
    }

    private static ProcessBuilder commandEncoded(String encoded) {
        return new ProcessBuilder("powershell", "-NoProfile", "-STA",
                "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
                "-EncodedCommand", encoded);
    }

    /** 兜底：把脚本写成临时 .ps1 再执行（编码命令不可用时）。 */
    private static String runViaScriptFile(String script) {
        Path ps1 = null;
        try {
            Path dir = ensureTempDir();
            if (dir == null) {
                lastError = "临时目录不可用（%TEMP% 不存在且无法创建）";
                logFailure("script-setup", lastError);
                return null;
            }
            ps1 = Files.createTempFile(dir, "mcdl-dialog-", ".ps1");
            Files.writeString(ps1, "\uFEFF" + script, StandardCharsets.UTF_8);
            ProcessBuilder pb = new ProcessBuilder("powershell", "-NoProfile", "-STA",
                    "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", ps1.toString());
            return exec(pb, "script-file");
        } catch (IOException e) {
            logFailure("script-setup", e);
            lastError = "无法启动系统文件对话框：" + describe(e);
            return null;
        } finally {
            deleteQuietly(ps1);
        }
    }

    /** 找一个可写的临时目录：优先 java.io.tmpdir，坏了就退到 ~/.mcdl/tmp。 */
    private static Path ensureTempDir() {
        String prop = System.getProperty("java.io.tmpdir");
        if (prop != null && !prop.isBlank()) {
            Path configured = Path.of(prop);
            try {
                Files.createDirectories(configured);
                if (Files.isWritable(configured)) {
                    return configured;
                }
            } catch (Exception ignored) {
                // 退到用户目录
            }
        }
        Path fallback = Path.of(System.getProperty("user.home"), ".mcdl", "tmp");
        try {
            Files.createDirectories(fallback);
            if (Files.isWritable(fallback)) {
                return fallback;
            }
        } catch (Exception ignored) {
            // 都不行只能放弃
        }
        return null;
    }

    /** 启动 PowerShell 并收集输出；失败时设置 lastError。 */
    private static String exec(ProcessBuilder pb, String stage) {
        Process p = null;
        try {
            pb.redirectErrorStream(true);
            p = pb.start();
            currentDialog = p;

            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            Process proc = p;
            Thread reader = new Thread(() -> {
                try (InputStream in = proc.getInputStream()) {
                    in.transferTo(buf);
                } catch (IOException ignored) {
                    // 进程被销毁时读取会中断，忽略
                }
            }, "mcdl-dialog-out");
            reader.setDaemon(true);
            reader.start();

            if (!p.waitFor(15, TimeUnit.MINUTES)) {
                p.destroyForcibly();
                p.waitFor(3, TimeUnit.SECONDS);
                lastError = "文件对话框超时未响应";
                logFailure(stage, lastError);
                return null;
            }
            reader.join(3000);
            String out = buf.toString(StandardCharsets.UTF_8).trim();
            if (out.startsWith("ERR:")) {
                logFailure(stage, out);
            }
            return out;
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            logFailure(stage, e);
            lastError = "无法启动系统文件对话框：" + describe(e);
            return null;
        } finally {
            if (currentDialog == p) {
                currentDialog = null;
                if (p != null && p.isAlive()) {
                    p.destroyForcibly();
                }
            }
        }
    }

    private static File parse(String out, boolean folder) {
        if (out == null || out.isBlank()) {
            if (lastError == null) {
                lastError = "PowerShell 没有返回结果";
            }
            return null;
        }
        for (String line : out.split("\\R")) {
            String s = line.trim();
            if (s.startsWith("OK:")) {
                String path = s.substring(3).trim();
                File file = new File(path);
                if (folder ? file.isDirectory() : file.isFile()) {
                    lastError = null;
                    return file;
                }
                lastError = "系统对话框返回了无效路径：" + path;
                return null;
            }
            if ("CANCEL".equals(s)) {
                lastError = null;
                return null;
            }
        }
        lastError = out;
        return null;
    }

    private static String describe(Throwable t) {
        String m = t.getMessage();
        return t.getClass().getSimpleName() + (m == null || m.isBlank() ? "" : "：" + m);
    }

    private static void deleteQuietly(Path p) {
        if (p == null) {
            return;
        }
        try {
            Files.deleteIfExists(p);
        } catch (IOException ignored) {
            // 临时文件删不掉不影响使用
        }
    }

    /** 失败诊断：写到 %USERPROFILE%\.mcdl\dialog-error.log（追加），便于用户反馈。 */
    private static void logFailure(String stage, Object detail) {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append(java.time.OffsetDateTime.now()).append(" [").append(stage).append("] ")
                    .append(detail).append('\n');
            sb.append("tmp=").append(System.getProperty("java.io.tmpdir"))
                    .append(" java=").append(System.getProperty("java.home")).append('\n');
            if (detail instanceof Throwable t) {
                StringWriter sw = new StringWriter();
                t.printStackTrace(new PrintWriter(sw));
                sb.append(sw).append('\n');
            }
            Path dir = Path.of(System.getProperty("user.home"), ".mcdl");
            Files.createDirectories(dir);
            Files.writeString(dir.resolve("dialog-error.log"), sb.toString(), StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (Exception ignored) {
            // 诊断日志写不进去不影响主流程
        }
    }

    private static String ps(String s) {
        return "'" + (s == null ? "" : s.replace("'", "''")) + "'";
    }

    /** 基于 IFileOpenDialog 的 COM 互操作实现。 */
    private static final String CS_DIALOG = """
            using System;
            using System.Runtime.InteropServices;

            public static class McdlDialog {
                [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
                private class FileOpenDialogRCW { }

                [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                private interface IFileDialog {
                    [PreserveSig] int Show(IntPtr parent);
                    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
                    void SetFileTypeIndex(uint iFileType);
                    void GetFileTypeIndex(out uint piFileType);
                    void Advise(IntPtr pfde, out uint pdwCookie);
                    void Unadvise(uint dwCookie);
                    void SetOptions(uint fos);
                    void GetOptions(out uint pfos);
                    void SetDefaultFolder(IShellItem psi);
                    void SetFolder(IShellItem psi);
                    void GetFolder(out IShellItem ppsi);
                    void GetCurrentSelection(out IShellItem ppsi);
                    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
                    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
                    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
                    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
                    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
                    void GetResult(out IShellItem ppsi);
                    void AddPlace(IShellItem psi, uint fdap);
                    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
                    void Close(int hr);
                    void SetClientGuid(ref Guid guid);
                    void ClearClientData();
                    void SetFilter(IntPtr pFilter);
                }

                [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
                private interface IShellItem {
                    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
                    void GetParent(out IShellItem ppsi);
                    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
                    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
                    void Compare(IShellItem psi, uint hint, out int piOrder);
                }

                [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
                private static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc,
                    ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

                [DllImport("user32.dll", CharSet = CharSet.Unicode)]
                private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

                [DllImport("kernel32.dll")]
                private static extern ushort SetThreadUILanguage(ushort langid);

                [DllImport("user32.dll")]
                private static extern bool SetForegroundWindow(IntPtr hWnd);

                [DllImport("user32.dll")]
                private static extern bool BringWindowToTop(IntPtr hWnd);

                [DllImport("user32.dll")]
                private static extern bool IsWindowVisible(IntPtr hWnd);

                [DllImport("user32.dll")]
                private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

                [DllImport("user32.dll", CharSet = CharSet.Unicode)]
                private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);

                private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

                [DllImport("user32.dll")]
                private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);

                private const ushort LANG_ZH_CN = 0x0804;
                private const uint GW_OWNER = 4;
                private const uint FOS_NOCHANGEDIR = 0x8;
                private const uint FOS_PICKFOLDERS = 0x20;
                private const uint FOS_FORCEFILESYSTEM = 0x40;
                private const uint FOS_PATHMUSTEXIST = 0x800;
                private const uint FOS_FILEMUSTEXIST = 0x1000;
                private const uint SIGDN_FILESYSPATH = 0x80058000;
                private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

                /**
                 * 后台把刚出现的对话框提到前台。PowerShell 是由 MCDL 拉起的子进程，
                 * 不主动激活时对话框可能压在主窗口下面，看起来像「点了没反应」。
                 */
                private static void ActivateWhenShown(IntPtr owner, string title) {
                    if (owner == IntPtr.Zero) {
                        return;
                    }
                    System.Threading.Thread t = new System.Threading.Thread(() => {
                        for (int i = 0; i < 200; i++) {
                            System.Threading.Thread.Sleep(50);
                            IntPtr found = FindOwned(owner, title);
                            if (found != IntPtr.Zero) {
                                SetForegroundWindow(found);
                                BringWindowToTop(found);
                                return;
                            }
                        }
                    });
                    t.IsBackground = true;
                    t.Start();
                }

                private static IntPtr FindOwned(IntPtr owner, string title) {
                    IntPtr result = IntPtr.Zero;
                    EnumWindows(delegate(IntPtr h, IntPtr l) {
                        if (GetWindow(h, GW_OWNER) != owner || !IsWindowVisible(h)) {
                            return true;
                        }
                        System.Text.StringBuilder sb = new System.Text.StringBuilder(256);
                        GetWindowText(h, sb, sb.Capacity);
                        string t = sb.ToString();
                        if (t.Length == 0 || (!string.IsNullOrEmpty(title) && t != title)) {
                            return true;
                        }
                        result = h;
                        return false;
                    }, IntPtr.Zero);
                    return result;
                }

                private static IntPtr ResolveOwner(long pid, string windowTitle) {
                    if (pid > 0) {
                        try {
                            System.Diagnostics.Process p = System.Diagnostics.Process.GetProcessById((int)pid);
                            p.Refresh();
                            if (p.MainWindowHandle != IntPtr.Zero) {
                                return p.MainWindowHandle;
                            }
                        } catch { }
                    }
                    if (!string.IsNullOrEmpty(windowTitle)) {
                        IntPtr h = FindWindow(null, windowTitle);
                        if (h != IntPtr.Zero) {
                            return h;
                        }
                    }
                    return IntPtr.Zero;
                }

                private static IFileDialog Create(string title, string initial, uint options) {
                    // 对话框跟随线程 UI 语言；MCDL 界面是中文，这里固定成简体中文，
                    // 避免系统显示语言为英文时出现「Select Folder / Cancel」。
                    try {
                        SetThreadUILanguage(LANG_ZH_CN);
                    } catch { }
                    IFileDialog dlg = (IFileDialog)new FileOpenDialogRCW();
                    uint current;
                    dlg.GetOptions(out current);
                    dlg.SetOptions(current | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR | options);
                    if (!string.IsNullOrEmpty(title)) {
                        dlg.SetTitle(title);
                    }
                    if (!string.IsNullOrEmpty(initial)) {
                        try {
                            Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                            IShellItem item;
                            SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out item);
                            if (item != null) {
                                dlg.SetFolder(item);
                            }
                        } catch { }
                    }
                    return dlg;
                }

                private static string Result(IFileDialog dlg) {
                    IShellItem item;
                    dlg.GetResult(out item);
                    IntPtr ptr;
                    item.GetDisplayName(SIGDN_FILESYSPATH, out ptr);
                    try {
                        return Marshal.PtrToStringUni(ptr);
                    } finally {
                        if (ptr != IntPtr.Zero) {
                            Marshal.FreeCoTaskMem(ptr);
                        }
                    }
                }

                public static string PickFolder(string title, string initial, long pid, string windowTitle) {
                    IFileDialog dlg = Create(title, initial, FOS_PICKFOLDERS | FOS_PATHMUSTEXIST);
                    IntPtr owner = ResolveOwner(pid, windowTitle);
                    ActivateWhenShown(owner, title);
                    int hr = dlg.Show(owner);
                    if (hr != 0) {
                        return hr == ERROR_CANCELLED ? null : "ERR:0x" + hr.ToString("X8");
                    }
                    return Result(dlg);
                }

                public static string PickFile(string title, string initial, string filterName,
                                              string filterSpec, long pid, string windowTitle) {
                    IFileDialog dlg = Create(title, initial, FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST);
                    if (!string.IsNullOrEmpty(filterSpec)) {
                        IntPtr pName = Marshal.StringToCoTaskMemUni(
                                string.IsNullOrEmpty(filterName) ? "文件" : filterName);
                        IntPtr pSpec = Marshal.StringToCoTaskMemUni(filterSpec);
                        IntPtr pArray = Marshal.AllocCoTaskMem(IntPtr.Size * 2);
                        try {
                            Marshal.WriteIntPtr(pArray, 0, pName);
                            Marshal.WriteIntPtr(pArray, IntPtr.Size, pSpec);
                            dlg.SetFileTypes(1, pArray);
                        } finally {
                            Marshal.FreeCoTaskMem(pArray);
                            Marshal.FreeCoTaskMem(pName);
                            Marshal.FreeCoTaskMem(pSpec);
                        }
                    }
                    IntPtr owner = ResolveOwner(pid, windowTitle);
                    ActivateWhenShown(owner, title);
                    int hr = dlg.Show(owner);
                    if (hr != 0) {
                        return hr == ERROR_CANCELLED ? null : "ERR:0x" + hr.ToString("X8");
                    }
                    return Result(dlg);
                }
            }
            """;
}
