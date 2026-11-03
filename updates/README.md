# updates/ —— 每次更新的工作区备份

这里保存每一次「覆盖式更新」的**改动文件快照 + 记录**，用于：

- 发版前核对这次到底改了哪些文件；
- 出问题时可回滚 / 对比（不依赖 git 是否提交、是否 push）；
- 记录测试结果与最终 zip 的 SHA-256。

**发版前先读：[覆盖式更新规则.md](覆盖式更新规则.md)**（版本号要改哪些地方、更新包该放什么、
怎么构建 / 验证 / 发布，以及发版检查清单）。这份规则会被 `backup.js` 自动复制进每个快照目录。

## 目录约定

```
updates/
  README.md               本说明
  覆盖式更新规则.md        当前遵守的覆盖式更新规则（发版必读，入库）
  backup.js               生成快照的脚本
  <name>/
    CHANGELOG.md          这次更新改了什么、为什么改（人写）
    manifest.json         基线 tag/commit、每个文件的 SHA-256 与大小、测试与产物记录
    files/                改动文件的完整副本（保留相对路径）
    覆盖式更新规则.md       生成快照时自动复制进来的规则副本
```

`<name>` 建议用「日期-主题」（如 `2026-11-03-music-java`）或「版本号」（如 `0.3.3`），
只用字母 / 数字 / `.` `_` `-`。

## 每次更新怎么用

```powershell
# 默认基线 = 当前 HEAD 能追到的最近 tag（也就是上一个已发布版本）
node updates/backup.js 2026-11-03-music-java

# 指定基线 / 备注
node updates/backup.js 0.3.3 --base v0.3.2 --note "音乐播放器 + Java 国内镜像"
```

脚本会：

1. 用 `git diff <base>`（含工作区未提交改动）+ `git ls-files --others` 列出改动文件；
2. 把它们原样复制到 `<name>/files/`；
3. 写 `manifest.json`：基线/HEAD commit、文件 SHA-256、大小、测试与产物占位；
4. 没有 `CHANGELOG.md` 时生成模板（已有则不覆盖）。

快照生成后，手动补两件事：

- 把 `CHANGELOG.md` 写完整（新功能 / 动效 UI / 修复 / 设置 / 验证）；
- 打包出 zip 后，把 `manifest.json` 的 `artifact` 填上：
  `{ "name": "MCDL-Launcher-0.3.3-x64.zip", "size": 154000000, "sha256": "..." }`；
- 如果同时出了「小版本更新包」，再加 `updatePackage`：
  `{ "name": "MCDL-Launcher-0.3.3-update.zip", "size": 109000000, "sha256": "...",
     "folder": "MCDL-Launcher-0.3.3-update", "contents": ["..."] }`。

## 注意

- **zip / 安装包本身不进这个目录**（每个 150 MB 左右），只记录文件名、大小、SHA-256。
- `updates/*/` 默认被 `.gitignore` 排除，属于本机备份；`README.md` 与 `backup.js` 会入库。
- 快照里的文件是「当时工作区的样子」，后续再改源码不会影响它——这正是备份的意义。
