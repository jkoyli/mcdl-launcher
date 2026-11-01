package mcdl.ui;

import java.awt.Color;
import java.awt.Font;
import java.awt.GraphicsEnvironment;
import java.util.Arrays;
import java.util.List;
import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JComponent;
import javax.swing.UIManager;
import javax.swing.border.Border;

/**
 * 深色主题：尽量用 UIManager 默认值覆盖，不依赖第三方外观库。
 */
public final class Theme {

    private Theme() {
    }

    public static final Color BG = new Color(0x1B1C1F);
    public static final Color PANEL = new Color(0x232529);
    public static final Color PANEL_2 = new Color(0x2B2E33);
    public static final Color FIELD = new Color(0x16171A);
    public static final Color TEXT = new Color(0xD7D9DC);
    public static final Color MUTED = new Color(0x8A8F98);
    public static final Color ACCENT = new Color(0x4C8DFF);
    public static final Color ACCENT_DARK = new Color(0x356FD1);
    public static final Color GREEN = new Color(0x49B36B);
    public static final Color RED = new Color(0xE05A5A);
    public static final Color BORDER = new Color(0x35383E);

    public static final String FONT_FAMILY = pickFont(
            "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Dialog");

    public static Font font(int style, int size) {
        return new Font(FONT_FAMILY, style, size);
    }

    private static String pickFont(String... candidates) {
        try {
            if (GraphicsEnvironment.isHeadless()) {
                return "Dialog";
            }
            List<String> installed = Arrays.asList(
                    GraphicsEnvironment.getLocalGraphicsEnvironment().getAvailableFontFamilyNames());
            for (String c : candidates) {
                if (installed.contains(c)) {
                    return c;
                }
            }
        } catch (Throwable ignored) {
            // 无图形环境时走默认字体
        }
        return "Dialog";
    }

    public static void apply() {
        Font base = font(Font.PLAIN, 13);
        Font small = font(Font.PLAIN, 12);
        Font bold = font(Font.BOLD, 13);

        UIManager.put("defaultFont", base);

        UIManager.put("Panel.background", PANEL);
        UIManager.put("OptionPane.background", PANEL);
        UIManager.put("OptionPane.messageForeground", TEXT);
        UIManager.put("Label.foreground", TEXT);
        UIManager.put("Label.font", base);
        UIManager.put("Button.font", bold);
        UIManager.put("Button.background", PANEL_2);
        UIManager.put("Button.foreground", TEXT);
        UIManager.put("Button.select", ACCENT_DARK);
        UIManager.put("Button.focus", new Color(0, 0, 0, 0));
        UIManager.put("Button.border", BorderFactory.createLineBorder(BORDER));

        UIManager.put("TextField.font", base);
        UIManager.put("TextField.background", FIELD);
        UIManager.put("TextField.foreground", TEXT);
        UIManager.put("TextField.caretForeground", ACCENT);
        UIManager.put("TextField.selectionBackground", ACCENT_DARK);
        UIManager.put("TextField.selectionForeground", Color.WHITE);
        UIManager.put("TextField.border", BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(BORDER), BorderFactory.createEmptyBorder(4, 6, 4, 6)));

        UIManager.put("TextArea.font", small);
        UIManager.put("TextArea.background", FIELD);
        UIManager.put("TextArea.foreground", new Color(0xB9BEC7));
        UIManager.put("TextArea.caretForeground", ACCENT);

        UIManager.put("ComboBox.font", base);
        UIManager.put("ComboBox.background", FIELD);
        UIManager.put("ComboBox.foreground", TEXT);
        UIManager.put("ComboBox.selectionBackground", ACCENT_DARK);
        UIManager.put("ComboBox.selectionForeground", Color.WHITE);
        UIManager.put("ComboBox.buttonBackground", PANEL_2);

        UIManager.put("CheckBox.font", base);
        UIManager.put("CheckBox.background", PANEL);
        UIManager.put("CheckBox.foreground", TEXT);

        UIManager.put("Spinner.font", base);
        UIManager.put("Spinner.background", FIELD);
        UIManager.put("Spinner.foreground", TEXT);

        UIManager.put("Table.font", base);
        UIManager.put("Table.background", PANEL);
        UIManager.put("Table.foreground", TEXT);
        UIManager.put("Table.selectionBackground", new Color(0x2F4F86));
        UIManager.put("Table.selectionForeground", Color.WHITE);
        UIManager.put("Table.gridColor", BORDER);
        UIManager.put("Table.showGrid", Boolean.FALSE);
        UIManager.put("Table.rowHeight", 26);

        UIManager.put("TableHeader.font", bold);
        UIManager.put("TableHeader.background", PANEL_2);
        UIManager.put("TableHeader.foreground", MUTED);

        UIManager.put("ScrollPane.background", PANEL);
        UIManager.put("Viewport.background", PANEL);
        UIManager.put("ScrollBar.background", PANEL);
        UIManager.put("ScrollBar.thumb", BORDER);
        UIManager.put("ScrollBar.track", PANEL);
        UIManager.put("ScrollBar.width", 10);

        UIManager.put("ProgressBar.background", FIELD);
        UIManager.put("ProgressBar.foreground", GREEN);
        UIManager.put("ProgressBar.selectionBackground", Color.WHITE);
        UIManager.put("ProgressBar.selectionForeground", Color.WHITE);
        UIManager.put("ProgressBar.font", small);

        UIManager.put("ToolTip.background", PANEL_2);
        UIManager.put("ToolTip.foreground", TEXT);
        UIManager.put("ToolTip.font", small);

        UIManager.put("SplitPane.background", BG);
        UIManager.put("SplitPane.dividerSize", 6);
    }

    /** 主色调按钮（安装）。 */
    public static JButton primaryButton(String text) {
        JButton b = new JButton(text);
        b.setBackground(ACCENT);
        b.setForeground(Color.WHITE);
        b.setFont(font(Font.BOLD, 14));
        b.setOpaque(true);
        b.setBorder(BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(ACCENT_DARK), BorderFactory.createEmptyBorder(8, 14, 8, 14)));
        b.setFocusPainted(false);
        b.setCursor(new java.awt.Cursor(java.awt.Cursor.HAND_CURSOR));
        return b;
    }

    /** 次要按钮。 */
    public static JButton button(String text) {
        JButton b = new JButton(text);
        b.setBackground(PANEL_2);
        b.setForeground(TEXT);
        b.setOpaque(true);
        b.setBorder(BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(BORDER), BorderFactory.createEmptyBorder(5, 10, 5, 10)));
        b.setFocusPainted(false);
        b.setCursor(new java.awt.Cursor(java.awt.Cursor.HAND_CURSOR));
        return b;
    }

    public static Border padding(int top, int left, int bottom, int right) {
        return BorderFactory.createEmptyBorder(top, left, bottom, right);
    }

    public static void style(JComponent c) {
        c.setBackground(PANEL);
        c.setForeground(TEXT);
        c.setFont(font(Font.PLAIN, 13));
    }
}
