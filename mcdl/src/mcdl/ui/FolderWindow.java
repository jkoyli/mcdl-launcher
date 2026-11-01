package mcdl.ui;

import java.awt.BorderLayout;
import java.awt.FlowLayout;
import java.awt.Font;
import java.awt.Frame;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.stream.Stream;

import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTable;
import javax.swing.ListSelectionModel;
import javax.swing.SwingUtilities;
import javax.swing.table.DefaultTableModel;

import mcdl.core.Installer;

/**
 * 应用内文件夹窗口：当系统 shell 被安全软件拦截、无法打开资源管理器时兜底。
 *
 * <p>只读浏览：面包屑路径、上一级、刷新、复制路径；双击目录进入，双击文件交给系统打开
 * （若系统也被拦截则提示）。不启动任何外部进程，因此不会被 HIPS 拦截。</p>
 */
final class FolderWindow {

    private FolderWindow() {
    }

    static void show(Frame owner, Path dir) {
        SwingUtilities.invokeLater(() -> new Win(owner, dir).open());
    }

    private static final class Win {
        private final Frame owner;
        private final JFrame frame = new JFrame();
        private final JLabel pathLabel = new JLabel();
        private final DefaultTableModel model = new DefaultTableModel(
                new String[]{"名称", "类型", "大小", "修改时间"}, 0) {
            @Override
            public boolean isCellEditable(int row, int column) {
                return false;
            }
        };
        private final JTable table = new JTable(model);
        private final List<Path> rows = new ArrayList<>();
        private Path current;

        Win(Frame owner, Path dir) {
            this.owner = owner;
            this.current = dir;
        }

        void open() {
            frame.setTitle("MCDL 文件夹");
            frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
            frame.setSize(860, 560);
            frame.setLocationRelativeTo(owner);
            frame.setLayout(new BorderLayout(0, 8));

            JPanel top = new JPanel(new BorderLayout(8, 6));
            top.setBorder(BorderFactory.createEmptyBorder(10, 12, 0, 12));
            pathLabel.setFont(Theme.font(Font.PLAIN, 12));
            pathLabel.setForeground(Theme.TEXT);
            top.add(pathLabel, BorderLayout.CENTER);

            JPanel buttons = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 0));
            JButton up = Theme.button("上一级");
            up.addActionListener(e -> navigate(current.getParent()));
            JButton refresh = Theme.button("刷新");
            refresh.addActionListener(e -> refresh());
            JButton copy = Theme.button("复制路径");
            copy.addActionListener(e -> {
                java.awt.Toolkit.getDefaultToolkit().getSystemClipboard()
                        .setContents(new java.awt.datatransfer.StringSelection(current.toString()), null);
            });
            JButton close = Theme.button("关闭");
            close.addActionListener(e -> frame.dispose());
            buttons.add(up);
            buttons.add(refresh);
            buttons.add(copy);
            buttons.add(close);
            top.add(buttons, BorderLayout.SOUTH);
            frame.add(top, BorderLayout.NORTH);

            table.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
            table.setRowHeight(24);
            table.getTableHeader().setReorderingAllowed(false);
            table.getColumnModel().getColumn(0).setPreferredWidth(360);
            table.getColumnModel().getColumn(1).setPreferredWidth(90);
            table.getColumnModel().getColumn(2).setPreferredWidth(100);
            table.getColumnModel().getColumn(3).setPreferredWidth(160);
            table.addMouseListener(new MouseAdapter() {
                @Override
                public void mouseClicked(MouseEvent e) {
                    if (e.getClickCount() == 2) {
                        int row = table.getSelectedRow();
                        if (row >= 0 && row < rows.size()) {
                            Path target = rows.get(row);
                            if (Files.isDirectory(target)) {
                                navigate(target);
                            } else {
                                openFile(target);
                            }
                        }
                    }
                }
            });
            JScrollPane scroll = new JScrollPane(table);
            scroll.setBorder(BorderFactory.createEmptyBorder(0, 12, 12, 12));
            frame.add(scroll, BorderLayout.CENTER);
            refresh();
            frame.setVisible(true);
        }

        private void navigate(Path dir) {
            if (dir != null && Files.isDirectory(dir)) {
                current = dir;
                refresh();
            }
        }

        private void refresh() {
            pathLabel.setText(current.toString());
            model.setRowCount(0);
            rows.clear();
            List<Path> entries = new ArrayList<>();
            try (Stream<Path> stream = Files.list(current)) {
                stream.forEach(entries::add);
            } catch (IOException e) {
                model.addRow(new Object[]{"（无法读取：" + e.getMessage() + "）", "", "", ""});
                return;
            }
            entries.sort(Comparator
                    .comparing((Path p) -> !Files.isDirectory(p))
                    .thenComparing(p -> p.getFileName().toString().toLowerCase(Locale.ROOT)));
            for (Path p : entries) {
                String name = p.getFileName().toString();
                boolean dir = Files.isDirectory(p);
                long size = -1;
                if (!dir) {
                    try {
                        size = Files.size(p);
                    } catch (IOException ignored) {
                        size = -1;
                    }
                }
                String modified = "";
                try {
                    modified = java.time.Instant.ofEpochMilli(Files.getLastModifiedTime(p).toMillis())
                            .atZone(java.time.ZoneId.systemDefault())
                            .toLocalDateTime().toString().replace('T', ' ');
                } catch (IOException ignored) {
                    modified = "";
                }
                model.addRow(new Object[]{name, dir ? "文件夹" : "文件",
                        dir || size < 0 ? "" : Installer.human(size), modified});
                rows.add(p);
            }
        }

        private void openFile(Path file) {
            try {
                if (java.awt.Desktop.isDesktopSupported()
                        && java.awt.Desktop.getDesktop().isSupported(java.awt.Desktop.Action.OPEN)) {
                    java.awt.Desktop.getDesktop().open(file.toFile());
                }
            } catch (Exception e) {
                JOptionPane.showMessageDialog(frame,
                        "无法打开文件（系统 shell 可能被安全软件拦截）：\n" + file,
                        "打开文件", JOptionPane.WARNING_MESSAGE);
            }
        }
    }
}
