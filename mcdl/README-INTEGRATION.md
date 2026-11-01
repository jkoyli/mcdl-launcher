# 内置 MCDL 下载器

这个目录是 `mcdl` 下载器的内置副本，随 `mcdl-launcher` 一起分发，**不需要额外安装 mcdl**。

目录内容：

- `src/`：mcdl Java 源码
- `native/`：Windows 原生文件夹选择器源码
- `mcdl.jar`：预构建的下载器 CLI / GUI
- `build.bat` / `build.ps1`：重新构建 `mcdl.jar`
- `README.md`：mcdl 原始说明
- `LICENSE`：mcdl 许可证

## Electron 如何调用

`electron/mcdl-service.js` 默认执行：

```text
<java> -Dfile.encoding=UTF-8 -jar mcdl-launcher/mcdl/mcdl.jar ...
```

也就是说，Electron UI 只依赖 `mcdl-launcher/mcdl/mcdl.jar`，不会读取项目外的 `..\mcdl`。

新建实例默认安装到 MCDL Launcher 自己的目录：

```text
%APPDATA%\MCDL Launcher\.minecraft
```

只有用户点击「扫描实例」时才会调用 `mcdl --list-dirs` 查找 PCL/HMCL；扫描结果由 Electron 缓存在：

```text
%APPDATA%\mcdl-launcher-electron\scanned-game-dirs.json
```

## 重新构建

需要 JDK 17+：

```powershell
cd mcdl-launcher\mcdl
.\build.ps1
```

或者：

```bat
build.bat
```

构建后会刷新同目录下的 `mcdl.jar`。

## 当前能力边界

mcdl 负责原版 Minecraft 文件下载与安装；启动器和加载器安装属于 `mcdl-launcher` 后续的 Java 启动核心工作。

Electron 的「新建实例」当前只调用 mcdl 的原版安装；Fabric / Forge / NeoForge / Quilt 选项保持禁用。
