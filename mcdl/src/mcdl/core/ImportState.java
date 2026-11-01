package mcdl.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 导入任务的状态：阶段标记、已完成文件、失败清单。
 *
 * <p>保存在实例目录的 {@code .mcdl-import.json}，用于进程中断后重新导入同一整合包时跳过已完成部分。</p>
 */
final class ImportState {

    static final String FILE_NAME = ".mcdl-import.json";

    /** 一个失败的文件。 */
    static final class Failed {
        String path = "";
        String label = "";
        String sha1 = "";
        long size = -1;
        List<String> urls = new ArrayList<>();
        String reason = "";

        Failed() {
        }

        Failed(String path, String label, String sha1, long size, List<String> urls, String reason) {
            this.path = path;
            this.label = label;
            this.sha1 = sha1 == null ? "" : sha1;
            this.size = size;
            this.urls = urls == null ? new ArrayList<>() : new ArrayList<>(urls);
            this.reason = reason == null ? "" : reason;
        }
    }

    String packSha1 = "";
    String mcVersion = "";
    String loader = "";
    boolean vanillaDone;
    boolean loaderDone;
    boolean overridesDone;
    boolean done;
    final Set<String> completed = new LinkedHashSet<>();
    final List<Failed> failed = new ArrayList<>();

    static ImportState load(Path instanceDir, String packSha1) {
        ImportState state = new ImportState();
        state.packSha1 = packSha1 == null ? "" : packSha1;
        Path file = instanceDir.resolve(FILE_NAME);
        if (!Files.isRegularFile(file)) {
            return state;
        }
        try {
            Json.Value obj = Json.parse(file);
            if (!state.packSha1.equals(obj.opt("packSha1").asString(""))) {
                return state;
            }
            state.mcVersion = obj.opt("mcVersion").asString("");
            state.loader = obj.opt("loader").asString("");
            state.vanillaDone = obj.opt("vanillaDone").asBoolean(false);
            state.loaderDone = obj.opt("loaderDone").asBoolean(false);
            state.overridesDone = obj.opt("overridesDone").asBoolean(false);
            state.done = obj.opt("done").asBoolean(false);
            for (Json.Value v : obj.path("completed").asList()) {
                String p = v.asString("");
                if (!p.isBlank()) {
                    state.completed.add(p);
                }
            }
            for (Json.Value v : obj.path("failed").asList()) {
                Failed f = new Failed();
                f.path = v.opt("path").asString("");
                f.label = v.opt("label").asString("");
                f.sha1 = v.opt("sha1").asString("");
                f.size = v.opt("size").asLong(-1);
                for (Json.Value u : v.path("urls").asList()) {
                    String s = u.asString("");
                    if (!s.isBlank()) {
                        f.urls.add(s);
                    }
                }
                f.reason = v.opt("reason").asString("");
                state.failed.add(f);
            }
        } catch (Exception ignored) {
            // 状态文件损坏则当作新任务
        }
        return state;
    }

    /**
     * 保存状态。加锁：下载线程会并发 add completed/failed，同时每 5 个文件调用一次 save；
     * 不加锁会在迭代集合时抛 ConcurrentModificationException，或写出截断的 JSON。
     */
    synchronized void save(Path instanceDir) {
        Json.Value obj = Json.Value.obj();
        obj.put("packSha1", packSha1);
        obj.put("mcVersion", mcVersion);
        obj.put("loader", loader);
        obj.put("vanillaDone", vanillaDone);
        obj.put("loaderDone", loaderDone);
        obj.put("overridesDone", overridesDone);
        obj.put("done", done);
        Json.Value completedArr = Json.Value.arr();
        for (String p : completed) {
            completedArr.add(Json.Value.of(p));
        }
        obj.put("completed", completedArr);
        Json.Value failedArr = Json.Value.arr();
        for (Failed f : failed) {
            Json.Value o = Json.Value.obj();
            o.put("path", f.path);
            o.put("label", f.label);
            o.put("sha1", f.sha1);
            o.put("size", f.size);
            Json.Value urls = Json.Value.arr();
            for (String u : f.urls) {
                urls.add(Json.Value.of(u));
            }
            o.put("urls", urls);
            o.put("reason", f.reason);
            failedArr.add(o);
        }
        obj.put("failed", failedArr);
        Path tmp = null;
        try {
            Files.createDirectories(instanceDir);
            // 每次用唯一临时文件，避免两个保存操作（或两个进程）互相覆盖同一个 .tmp
            tmp = Files.createTempFile(instanceDir, FILE_NAME + "-", ".tmp");
            Files.writeString(tmp, obj.toPrettyString(), StandardCharsets.UTF_8);
            Files.move(tmp, instanceDir.resolve(FILE_NAME), StandardCopyOption.REPLACE_EXISTING);
            tmp = null;
        } catch (IOException ignored) {
            // 状态写不进去不影响安装
        } finally {
            if (tmp != null) {
                try {
                    Files.deleteIfExists(tmp);
                } catch (IOException ignored) {
                    // 忽略
                }
            }
        }
    }

    synchronized boolean isCompleted(String path, Path dest) {
        if (completed.contains(path) && Files.isRegularFile(dest)) {
            return true;
        }
        return false;
    }
}
