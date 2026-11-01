package mcdl.core;

import java.io.IOException;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 协作式取消标记。
 *
 * <p>安装 / 导入线程在阶段边界和每个文件之前调用 {@link #throwIfCancelled()}；
 * 取消时先置位，再依次执行通过 {@link #onCancel(Runnable)} 注册的钩子
 * （关闭线程池、取消 {@link Installer}、销毁 Forge 安装器子进程等），
 * 让阻塞在 IO 上的任务尽快退出。</p>
 *
 * <p>与网络错误、磁盘错误区分开：取消抛 {@link Cancelled}，调用方据此安静收尾，
 * 不弹「安装失败」对话框，也不把半途的文件记进失败清单。</p>
 */
public final class Cancel {

    /** 用户主动取消。属于 IOException，便于沿现有 throws 声明向上传递。 */
    public static final class Cancelled extends IOException {
        public Cancelled() {
            super("操作已取消");
        }

        public Cancelled(String message) {
            super(message);
        }
    }

    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final CopyOnWriteArrayList<Runnable> hooks = new CopyOnWriteArrayList<>();

    public boolean isCancelled() {
        return cancelled.get();
    }

    /** 已取消则抛出 {@link Cancelled}。 */
    public void throwIfCancelled() throws Cancelled {
        if (cancelled.get()) {
            throw new Cancelled();
        }
    }

    /** 置位并执行钩子；重复调用无副作用。 */
    public void cancel() {
        if (!cancelled.compareAndSet(false, true)) {
            return;
        }
        for (Runnable hook : hooks) {
            runQuietly(hook);
        }
    }

    /** 注册取消时要执行的动作；若已经取消则立即执行。 */
    public void onCancel(Runnable hook) {
        if (hook == null) {
            return;
        }
        hooks.add(hook);
        if (cancelled.get()) {
            runQuietly(hook);
        }
    }

    private static void runQuietly(Runnable hook) {
        try {
            hook.run();
        } catch (RuntimeException ignored) {
            // 一个清理钩子失败不能挡住其他清理动作
        }
    }
}
