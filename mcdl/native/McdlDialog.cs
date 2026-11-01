using System;
using System.IO;
using System.Reflection;
using System.Text;
using System.Runtime.InteropServices;

/// <summary>
/// MCDL 的原生文件 / 文件夹选择器。
///
/// 用法（由 Java 侧调用）：
///   McdlDialog.exe folder|file &lt;titleB64&gt; &lt;initialB64&gt; &lt;filterNameB64&gt; &lt;filterSpecB64&gt;
///                  &lt;ownerPid&gt; &lt;ownerTitleB64&gt; &lt;resultFile&gt;
///
/// 结果写入 resultFile：OK:&lt;路径&gt; / CANCEL / ERR:&lt;原因&gt;。
/// 编译成 winexe，不弹控制台；不依赖 PowerShell、Add-Type 或临时脚本。
/// </summary>
internal static class McdlDialog
{
    private const uint FOS_NOCHANGEDIR = 0x8;
    private const uint FOS_PICKFOLDERS = 0x20;
    private const uint FOS_FORCEFILESYSTEM = 0x40;
    private const uint FOS_PATHMUSTEXIST = 0x800;
    private const uint FOS_FILEMUSTEXIST = 0x1000;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int ERROR_CANCELLED = unchecked((int)0x800704C7);
    private const uint GW_OWNER = 4;

    [STAThread]
    private static int Main(string[] args)
    {
        string result;
        try
        {
            // 结果通过 stdout 回传：安全软件可能拦截新进程的文件写入，但控制台管道可用。
            if (args.Length >= 2 && args[0] == "shopen")
            {
                string target = Decode(args[1]);
                string openError;
                bool opened = OpenFolderNative(target, out openError);
                WriteStdout(opened ? "OK" : "ERR:" + openError);
                return opened ? 0 : 1;
            }
            if (args.Length >= 2 && args[0] == "opencom")
            {
                string target = Decode(args[1]);
                try
                {
                    Type shellType = Type.GetTypeFromProgID("Shell.Application");
                    object shell = Activator.CreateInstance(shellType);
                    shellType.InvokeMember("Explore", BindingFlags.InvokeMethod, null, shell,
                        new object[] { target });
                    WriteStdout("OK");
                    return 0;
                }
                catch (Exception e)
                {
                    WriteStdout("ERR:" + e.Message);
                    return 1;
                }
            }
            if (args.Length >= 2 && args[0] == "open")
            {
                string target = Decode(args[1]);
                string openError;
                // 先试 SHOpenFolderAndSelectItems，再试 ShellExecuteEx
                bool opened = OpenFolderNative(target, out openError)
                        || ShellOpen(target, out openError);
                WriteStdout(opened ? "OK" : "ERR:" + openError);
                return opened ? 0 : 1;
            }
            if (args.Length < 7)
            {
                WriteStdout("ERR:参数不足");
                return 2;
            }
            string mode = args[0];
            string title = Decode(args[1]);
            string initial = Decode(args[2]);
            string filterName = Decode(args[3]);
            string filterSpec = Decode(args[4]);
            long pid = long.Parse(args[5]);
            string windowTitle = Decode(args[6]);

            // MCDL 界面是中文；固定线程 UI 语言，避免出现英文按钮
            try { SetThreadUILanguage(0x0804); } catch { }

            result = mode == "folder"
                ? PickFolder(title, initial, pid, windowTitle)
                : PickFile(title, initial, filterName, filterSpec, pid, windowTitle);
            if (result == null)
            {
                result = "CANCEL";
            }
        }
        catch (Exception e)
        {
            result = "ERR:" + e.Message;
            WriteStdout(result);
            return 1;
        }
        WriteStdout(result);
        return 0;
    }

    private static void WriteStdout(string text)
    {
        try
        {
            using (Stream stdout = Console.OpenStandardOutput())
            {
                byte[] data = new UTF8Encoding(false).GetBytes(text);
                stdout.Write(data, 0, data.Length);
                stdout.Flush();
            }
        }
        catch { }
    }

    /// <summary>用 SHOpenFolderAndSelectItems 打开目录；不经过 ShellExecute / CreateProcess。</summary>
    private static bool OpenFolderNative(string path, out string error)
    {
        error = null;
        if (string.IsNullOrEmpty(path))
        {
            error = "路径为空";
            return false;
        }
        try
        {
            Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            IShellItem item;
            SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
            if (item == null)
            {
                error = "无法解析路径：" + path;
                return false;
            }
            int hr = SHOpenFolderAndSelectItems(item, 0, IntPtr.Zero, 0);
            if (hr == 0)
            {
                return true;
            }
            error = "SHOpenFolderAndSelectItems 0x" + hr.ToString("X8");
            return false;
        }
        catch (Exception e)
        {
            error = e.Message;
            return false;
        }
    }

    [DllImport("shell32.dll")]
    private static extern int SHOpenFolderAndSelectItems(IShellItem folder, uint cidl,
        IntPtr apidl, uint flags);

    /// <summary>用 ShellExecuteEx 打开目录；返回失败原因供 Java 记录。</summary>
    private static bool ShellOpen(string path, out string error)
    {
        error = null;
        if (string.IsNullOrEmpty(path))
        {
            error = "路径为空";
            return false;
        }
        SHELLEXECUTEINFO info = new SHELLEXECUTEINFO();
        info.cbSize = Marshal.SizeOf(typeof(SHELLEXECUTEINFO));
        info.fMask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
        info.lpVerb = "open";
        info.lpFile = path;
        info.nShow = 1;
        if (ShellExecuteEx(ref info))
        {
            return true;
        }
        int code = Marshal.GetLastWin32Error();
        error = "ShellExecuteEx 失败（Win32=" + code + "）";
        return false;
    }

    private static string Decode(string base64)
    {
        if (string.IsNullOrEmpty(base64))
        {
            return "";
        }
        return Encoding.UTF8.GetString(Convert.FromBase64String(base64));
    }

    private static string PickFolder(string title, string initial, long pid, string windowTitle)
    {
        return ShowAndResult(title, initial, FOS_PICKFOLDERS | FOS_PATHMUSTEXIST, "", "", pid, windowTitle);
    }

    private static string PickFile(string title, string initial, string filterName,
                                   string filterSpec, long pid, string windowTitle)
    {
        return ShowAndResult(title, initial, FOS_FILEMUSTEXIST | FOS_PATHMUSTEXIST,
            filterName, filterSpec, pid, windowTitle);
    }

    private static string ShowAndResult(string title, string initial, uint options,
                                        string filterName, string filterSpec,
                                        long pid, string windowTitle)
    {
        IFileDialog dialog = Create(title, initial, options);
        ApplyFilter(dialog, filterName, filterSpec);
        IntPtr owner = ResolveOwner(pid, windowTitle);
        ActivateWhenShown(owner, title);
        int hr = dialog.Show(owner);
        if (hr != 0 && hr != ERROR_CANCELLED && owner != IntPtr.Zero)
        {
            // 某些环境不允许跨进程 owner，退回无 owner 再试一次
            IFileDialog retry = Create(title, initial, options);
            ApplyFilter(retry, filterName, filterSpec);
            hr = retry.Show(IntPtr.Zero);
            if (hr == 0)
            {
                return "OK:" + Result(retry);
            }
        }
        if (hr != 0)
        {
            if (hr == ERROR_CANCELLED) return null;
            throw new COMException("IFileDialog.Show 失败 0x" + hr.ToString("X8"), hr);
        }
        return "OK:" + Result(dialog);
    }

    private static void ApplyFilter(IFileDialog dialog, string filterName, string filterSpec)
    {
        if (string.IsNullOrEmpty(filterSpec))
        {
            return;
        }
        IntPtr namePtr = Marshal.StringToCoTaskMemUni(
            string.IsNullOrEmpty(filterName) ? "文件" : filterName);
        IntPtr specPtr = Marshal.StringToCoTaskMemUni(filterSpec);
        IntPtr arrayPtr = Marshal.AllocCoTaskMem(IntPtr.Size * 2);
        try
        {
            Marshal.WriteIntPtr(arrayPtr, 0, namePtr);
            Marshal.WriteIntPtr(arrayPtr, IntPtr.Size, specPtr);
            dialog.SetFileTypes(1, arrayPtr);
        }
        finally
        {
            Marshal.FreeCoTaskMem(arrayPtr);
            Marshal.FreeCoTaskMem(namePtr);
            Marshal.FreeCoTaskMem(specPtr);
        }
    }

    private static IFileDialog Create(string title, string initial, uint options)
    {
        IFileDialog dialog = (IFileDialog)new FileOpenDialogRCW();
        uint current;
        dialog.GetOptions(out current);
        dialog.SetOptions(current | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR | options);
        if (!string.IsNullOrEmpty(title))
        {
            dialog.SetTitle(title);
        }
        if (!string.IsNullOrEmpty(initial))
        {
            try
            {
                Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                IShellItem item;
                SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out item);
                if (item != null)
                {
                    dialog.SetFolder(item);
                }
            }
            catch { }
        }
        return dialog;
    }

    private static string Result(IFileDialog dialog)
    {
        IShellItem item;
        dialog.GetResult(out item);
        IntPtr ptr;
        item.GetDisplayName(SIGDN_FILESYSPATH, out ptr);
        try
        {
            return Marshal.PtrToStringUni(ptr);
        }
        finally
        {
            if (ptr != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(ptr);
            }
        }
    }

    /// <summary>把刚出现的对话框提到前台；不主动激活时它可能被主窗口压住。</summary>
    private static void ActivateWhenShown(IntPtr owner, string title)
    {
        if (owner == IntPtr.Zero)
        {
            return;
        }
        System.Threading.Thread thread = new System.Threading.Thread(delegate()
        {
            for (int i = 0; i < 200; i++)
            {
                System.Threading.Thread.Sleep(50);
                IntPtr found = FindOwned(owner, title);
                if (found != IntPtr.Zero)
                {
                    SetForegroundWindow(found);
                    BringWindowToTop(found);
                    return;
                }
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    private static IntPtr FindOwned(IntPtr owner, string title)
    {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (GetWindow(hWnd, GW_OWNER) != owner || !IsWindowVisible(hWnd))
            {
                return true;
            }
            StringBuilder sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, sb.Capacity);
            string text = sb.ToString();
            if (text.Length == 0 || (!string.IsNullOrEmpty(title) && text != title))
            {
                return true;
            }
            result = hWnd;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    private static IntPtr ResolveOwner(long pid, string windowTitle)
    {
        // 先按标题找：Swing 主窗口标题是精确的，比 MainWindowHandle 可靠
        if (!string.IsNullOrEmpty(windowTitle))
        {
            IntPtr byTitle = FindWindow(null, windowTitle);
            if (byTitle != IntPtr.Zero && IsWindow(byTitle))
            {
                return byTitle;
            }
        }
        if (pid > 0)
        {
            try
            {
                System.Diagnostics.Process p = System.Diagnostics.Process.GetProcessById((int)pid);
                p.Refresh();
                if (p.MainWindowHandle != IntPtr.Zero && IsWindow(p.MainWindowHandle))
                {
                    return p.MainWindowHandle;
                }
            }
            catch { }
        }
        return IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHELLEXECUTEINFO
    {
        public int cbSize;
        public uint fMask;
        public IntPtr hwnd;
        public string lpVerb;
        public string lpFile;
        public string lpParameters;
        public string lpDirectory;
        public int nShow;
        public IntPtr hInstApp;
        public IntPtr lpIDList;
        public string lpClass;
        public IntPtr hkeyClass;
        public uint dwHotKey;
        public IntPtr hIcon;
        public IntPtr hProcess;
    }

    private const uint SEE_MASK_NOASYNC = 0x100;
    private const uint SEE_MASK_FLAG_NO_UI = 0x400;

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ShellExecuteEx(ref SHELLEXECUTEINFO info);

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRCW { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
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
    private interface IShellItem
    {
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
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);

    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
}
