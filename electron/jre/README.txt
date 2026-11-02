此目录用于放置内置 JRE（Windows x64）。不要提交二进制。

获取方式：`npm run fetch:jre`（流式下载 Temurin JRE 21 并解压到本目录）。
打包时 extraResources 会把整个 jre/ 放进 resources/jre/；
运行时按「里面有 bin/java.exe」判断是否可用，README 存在但没 java.exe 会正确返回 null。

解析优先级：MCDL_JAVA → 内置 JRE → 已登记的 JDK → JAVA_HOME → 常见目录 → PATH

本文件是占位，保证 electron-builder 的 extraResources 源目录始终存在（目录缺失会导致打包报错）。
