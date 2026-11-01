# 内置 MCDL 下载器

本目录是 `mcdl` 下载器的内置副本，随 `mcdl-launcher` 一起分发，无需单独安装。

| 内容 | 说明 |
| --- | --- |
| `src/` | mcdl Java 源码 |
| `native/` | Windows 原生文件夹选择器源码 |
| `mcdl.jar` | 预构建的 CLI / GUI |
| `build.bat` / `build.ps1` | 重新构建 `mcdl.jar`（需 JDK 17+） |
| `README.md` | 上游原始说明 |
| `LICENSE` | MIT |

调用方式与能力边界见 [../docs/development.md](../docs/development.md#与-mcdl-的边界)。

`mcdl` 只负责原版 Minecraft 文件的下载与安装；账户、启动参数与进程管理都在 `electron/` 中实现。
