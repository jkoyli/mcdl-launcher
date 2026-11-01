package mcdl.core;

import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 回归测试：多个下载线程同时写 completed/failed，同时定期 save，不能抛
 * ConcurrentModificationException，也不能写出无法解析的 JSON。
 */
public final class ImportStateStressTest {

    public static void main(String[] args) throws Exception {
        Path dir = Files.createTempDirectory("mcdl-state-stress-");
        try {
            ImportState state = new ImportState();
            state.packSha1 = "pack";
            int threads = 8;
            int perThread = 250;

            ExecutorService pool = Executors.newFixedThreadPool(threads + 1);
            AtomicReference<Throwable> error = new AtomicReference<>();
            List<Future<?>> futures = new ArrayList<>();

            for (int t = 0; t < threads; t++) {
                final int thread = t;
                futures.add(pool.submit(() -> {
                    try {
                        for (int i = 0; i < perThread; i++) {
                            String path = "f" + thread + "-" + i;
                            synchronized (state) {
                                state.completed.add(path);
                                if (i % 7 == 0) {
                                    state.failed.add(new ImportState.Failed(
                                            path, path, "", 1, List.of("https://example.invalid"), "x"));
                                }
                            }
                            if (i % 5 == 0) {
                                state.save(dir);
                            }
                        }
                    } catch (Throwable e) {
                        error.compareAndSet(null, e);
                    }
                }));
            }
            // 主线程同时保存，模拟安装线程与下载线程并发
            futures.add(pool.submit(() -> {
                try {
                    for (int i = 0; i < 300; i++) {
                        state.save(dir);
                    }
                } catch (Throwable e) {
                    error.compareAndSet(null, e);
                }
            }));

            for (Future<?> future : futures) {
                future.get(120, TimeUnit.SECONDS);
            }
            pool.shutdown();
            // 所有线程结束后再保存一次，等价于 Modpack 在阶段结束时的那次 save
            state.save(dir);

            if (error.get() != null) {
                error.get().printStackTrace();
                throw new AssertionError("并发保存抛异常：" + error.get());
            }
            ImportState loaded = ImportState.load(dir, "pack");
            int expected = threads * perThread;
            if (loaded.completed.size() != expected) {
                throw new AssertionError("状态不完整：期望 " + expected
                        + "，实际 " + loaded.completed.size());
            }
            System.out.println("PASS: 并发保存后状态完整，completed=" + loaded.completed.size()
                    + "，failed=" + loaded.failed.size());
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
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs)
                        throws java.io.IOException {
                    Files.deleteIfExists(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path dir, java.io.IOException exc)
                        throws java.io.IOException {
                    Files.deleteIfExists(dir);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (java.io.IOException ignored) {
            // 清理失败不影响测试结论
        }
    }
}
