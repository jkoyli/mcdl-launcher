import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.List;

import mcdl.core.Installer;
import mcdl.core.Sources;

/**
 * 回归测试：下载失败时必须报出真实原因，而不是「安装失败：null」，也不能永久卡住。
 *
 * <p>做法：把 1.20.1 资源索引前几个对象的落盘位置预先建成「非空目录」，让原子改名失败。
 * 测试需要联网（拉版本 JSON 与资源索引），耗时约 10–60 秒。</p>
 */
public final class FailureInstallTest {

    /** 1.20.1 资源索引里前 5 个对象的 SHA-1（图标文件）。 */
    private static final List<String> BLOCKED_HASHES = List.of(
            "5ff04807c356f1beed0b86ccf659b44b9983e3fa",
            "8030dd9dc315c0381d52c4782ea36c6baf6e8135",
            "af96f55a90eaf11b327f1b5f8834a051027dc506",
            "b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356",
            "b80b6e9ff01c78c624df5429e1d3dcd3d5130834");

    public static void main(String[] args) throws Exception {
        Path dir = Files.createTempDirectory("mcdl-failure-test-");
        long started = System.currentTimeMillis();
        try {
            for (String hash : BLOCKED_HASHES) {
                Path blocked = dir.resolve("assets").resolve("objects")
                        .resolve(hash.substring(0, 2)).resolve(hash);
                Files.createDirectories(blocked);
                Files.writeString(blocked.resolve("keep.txt"), "block");
            }

            Installer.Options options = new Installer.Options();
            options.dir = dir;
            options.source = Sources.Source.OFFICIAL;
            options.jobs = 4;
            options.assets = true;
            options.assetsOnly = true;
            options.limitAssets = 5;
            options.log = message -> {
            };

            String message = null;
            try {
                new Installer(options).install("1.20.1");
            } catch (IOException e) {
                message = e.getMessage();
            }
            if (message == null) {
                throw new AssertionError("故意制造失败，但安装没有抛异常");
            }
            if ("null".equals(message) || message.isBlank()) {
                throw new AssertionError("错误信息为空：安装失败：" + message);
            }
            if (!message.contains("下载失败")) {
                throw new AssertionError("错误信息里没有真实原因：" + message);
            }
            long elapsed = System.currentTimeMillis() - started;
            if (elapsed > 180_000L) {
                throw new AssertionError("失败路径耗时过长（" + elapsed + " ms），可能又卡住了");
            }
            System.out.println("PASS: 失败信息 = " + message + "（" + elapsed + " ms）");
        } finally {
            deleteTree(dir);
        }
    }

    private static void deleteTree(Path root) {
        if (root == null || !Files.exists(root)) {
            return;
        }
        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                    Files.deleteIfExists(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path dir, IOException exc) throws IOException {
                    Files.deleteIfExists(dir);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException ignored) {
            // 清理失败不影响测试结论
        }
    }
}
