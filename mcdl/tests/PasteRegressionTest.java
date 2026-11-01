import java.awt.Component;
import java.awt.Container;
import java.awt.GraphicsEnvironment;
import java.awt.datatransfer.StringSelection;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Path;

import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JFrame;
import javax.swing.JPanel;
import javax.swing.JTextField;
import javax.swing.SwingUtilities;
import javax.swing.text.JTextComponent;

import mcdl.core.Sources;

/**
 * 回归测试：给主窗口装上拖拽支持后，文本框仍然可以 Ctrl+V 粘贴。
 *
 * <p>运行需要图形环境（会创建一个不显示的 JFrame）。</p>
 */
public final class PasteRegressionTest {

    private static int textWithOurHandler;
    private static int textTotal;
    private static int otherWithHandler;

    public static void main(String[] args) throws Exception {
        if (GraphicsEnvironment.isHeadless()) {
            System.out.println("SKIP: 无图形环境");
            return;
        }
        try {
            SwingUtilities.invokeAndWait(() -> {
                try {
                    run();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
        } catch (InvocationTargetException e) {
            System.out.println("FAIL: " + e.getCause());
            System.exit(1);
        }
        System.out.println("PASS: 文本框粘贴未被拖拽 handler 破坏");
    }

    private static void run() throws Exception {
        Class<?> mainWindow = Class.forName("mcdl.ui.MainWindow");
        Constructor<?> constructor = mainWindow.getDeclaredConstructor(Path.class, Sources.Source.class);
        constructor.setAccessible(true);
        Object window = constructor.newInstance(null, Sources.Source.AUTO);

        Field frameField = mainWindow.getDeclaredField("frame");
        frameField.setAccessible(true);
        JFrame frame = (JFrame) frameField.get(window);

        Method buildContent = mainWindow.getDeclaredMethod("buildContent");
        buildContent.setAccessible(true);
        JPanel content = (JPanel) buildContent.invoke(window);
        frame.setContentPane(content);

        Method installDropSupport = mainWindow.getDeclaredMethod("installDropSupport");
        installDropSupport.setAccessible(true);
        installDropSupport.invoke(window);

        countHandlers(content);
        if (textWithOurHandler != 0) {
            throw new AssertionError("有 " + textWithOurHandler + "/" + textTotal
                    + " 个文本组件被拖拽 handler 覆盖");
        }
        if (otherWithHandler == 0) {
            throw new AssertionError("拖拽 handler 没有装到任何非文本组件上");
        }

        Field dirField = mainWindow.getDeclaredField("dirBox");
        dirField.setAccessible(true);
        @SuppressWarnings("unchecked")
        JComboBox<String> dirBox = (JComboBox<String>) dirField.get(window);
        JTextField editor = (JTextField) dirBox.getEditor().getEditorComponent();

        java.awt.Toolkit.getDefaultToolkit().getSystemClipboard()
                .setContents(new StringSelection("PASTED-OK"), null);
        editor.setText("old");
        editor.selectAll();
        editor.paste();
        if (!"PASTED-OK".equals(editor.getText())) {
            throw new AssertionError("粘贴后文本为 " + editor.getText());
        }

        frame.dispose();
    }

    private static void countHandlers(Container container) {
        for (Component child : container.getComponents()) {
            if (child instanceof JTextComponent text) {
                textTotal++;
                if (text.getTransferHandler() != null
                        && text.getTransferHandler().getClass().getName().startsWith("mcdl.ui.MainWindow$")) {
                    textWithOurHandler++;
                }
            } else if (child instanceof JComponent component) {
                if (component.getTransferHandler() != null
                        && component.getTransferHandler().getClass().getName().startsWith("mcdl.ui.MainWindow$")) {
                    otherWithHandler++;
                }
            }
            if (child instanceof Container nested) {
                countHandlers(nested);
            }
        }
    }
}
