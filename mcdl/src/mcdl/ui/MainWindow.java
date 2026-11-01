package mcdl.ui;

import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Component;
import java.awt.Cursor;
import java.awt.Desktop;
import java.awt.Dimension;
import java.awt.Font;
import java.awt.GridBagConstraints;
import java.awt.GridBagLayout;
import java.awt.Insets;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JFileChooser;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JProgressBar;
import javax.swing.JScrollPane;
import javax.swing.JSpinner;
import javax.swing.JSplitPane;
import javax.swing.JTable;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.ListSelectionModel;
import javax.swing.SpinnerNumberModel;
import javax.swing.SwingUtilities;
import javax.swing.SwingWorker;
import javax.swing.Timer;
import javax.swing.table.DefaultTableCellRenderer;

import mcdl.core.Cancel;
import mcdl.core.Installer;
import mcdl.core.JavaFinder;
import mcdl.core.LauncherDirs;
import mcdl.core.Manifest;
import mcdl.core.Modpack;
import mcdl.core.ModpackLink;
import mcdl.core.Sources;
import mcdl.core.VersionService;

/**
 * 图形界面：左侧版本列表，右侧安装选项 + 进度 + 日志。
 *
 * <p>界面线程只做展示：版本清单在 SwingWorker 里拉，安装在独立线程跑，
 * 进度由 300ms 的 Timer 轮询 {@link Installer.Stats}，避免下载线程直接碰 Swing。</p>
 */
public final class MainWindow {

    private static MainWindow instance;

    private final Path initialDir;
    private final Sources.Source initialSource;
    /** 命令行 --gui --dir 显式指定的目录：自动识别时不要覆盖它。 */
    private final boolean initialDirExplicit;

    private final JFrame frame = new JFrame("MCDL " + mcdl.Main.VERSION + " · Minecraft 版本下载器");
    private final JComboBox<String> dirBox = new JComboBox<>();
    private final JButton detectBtn = Theme.button("识别目录");
    private volatile boolean updatingDirBox;
    private final JComboBox<Sources.Source> sourceBox = new JComboBox<>(Sources.Source.values());
    private final JButton mirrorBtn = Theme.button("镜像源");
    private final JTextField searchField = new JTextField();
    private final JComboBox<String> typeBox = new JComboBox<>(new String[]{"全部", "正式版", "快照", "远古"});
    private final VersionTableModel model = new VersionTableModel();
    private final JTable table = new JTable(model);
    private final JSpinner jobsSpinner = new JSpinner(new SpinnerNumberModel(16, 1, 128, 1));
    private final JCheckBox verifyBox = new JCheckBox("校验已存在的文件（SHA-1，慢）");
    private final JCheckBox assetsBox = new JCheckBox("下载资源文件（声音 / 语言 / 贴图）", true);
    private final JButton installBtn = Theme.primaryButton("开始安装");
    private final JButton cancelBtn = Theme.button("取消");
    private final JButton openBtn = Theme.button("打开目录");
    private final JButton packBtn = Theme.button("导入整合包…");
    private final JTextField cfKeyField = new JTextField();
    private final JButton cfTestBtn = Theme.button("验证");
    private JPanel clipBar;
    private JLabel clipLabel;
    private String clipUrl;
    private String lastClipText = "";
    private String dismissedClip = "";
    private javax.swing.Timer clipTimer;
    private Path lastPackFile;
    private Path lastPackDir;
    private String lastPackName;
    private String lastPackKey;
    private final JLabel cfKeyHint = new JLabel("仅 CurseForge 包需要；console.curseforge.com → API Keys；留空先试镜像");
    private final JButton refreshBtn = Theme.button("刷新列表");
    private final JButton browseBtn = Theme.button("浏览…");
    private final JProgressBar progress = new JProgressBar(0, 1000);
    private final JLabel statusLabel = new JLabel("准备就绪");
    private final JLabel speedLabel = new JLabel(" ");
    private final JLabel selectedLabel = new JLabel("未选择版本");
    private final JLabel detailLabel = new JLabel(" ");
    private final JTextArea logArea = new JTextArea(6, 40);
    private final Timer pollTimer;
    private final JLabel emptyLabel = new JLabel();
    private final JComboBox<JavaChoice> javaBox = new JComboBox<>();
    private final JButton scanJavaBtn = Theme.button("重新扫描");
    private final JLabel javaDetail = new JLabel("正在扫描本机 Java…");
    private JPanel listCards;
    private JSplitPane mainSplit;

    private volatile Manifest.Data manifest;
    private volatile Installer installer;
    /** 整合包导入 / 失败重试的取消标记（与 {@link #installer} 二选一在使用）。 */
    private volatile Cancel packCancel;
    private volatile boolean busy;
    private volatile List<JavaFinder.JavaInfo> javas = List.of();
    private volatile int requiredJava = -1;
    private volatile String requiredFor = "";
    private volatile boolean updatingJavaBox;
    private volatile boolean scanningJava;
    private volatile boolean queryingJava;

    public static void launch() {
        launch(null, Sources.Source.AUTO);
    }

    public static void launch(Path dir, Sources.Source source) {
        Theme.apply();
        SwingUtilities.invokeLater(() -> {
            if (instance != null) {
                instance.frame.setVisible(true);
                instance.frame.toFront();
                return;
            }
            instance = new MainWindow(dir, source);
            instance.show();
        });
    }

    private MainWindow(Path dir, Sources.Source source) {
        this.initialDir = dir == null ? defaultDir() : dir;
        this.initialDirExplicit = dir != null;
        this.initialSource = source == null ? Sources.Source.AUTO : source;
        typeBox.setSelectedItem("正式版");
        this.pollTimer = new Timer(300, e -> updateProgress());
    }

    private static Path defaultDir() {
        String appData = System.getenv("APPDATA");
        if (appData != null && !appData.isEmpty()) {
            return Paths.get(appData, ".minecraft");
        }
        return Paths.get(System.getProperty("user.home"), ".minecraft");
    }

    private void show() {
        frame.setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);
        frame.setContentPane(buildContent());
        installDropSupport();
        frame.setSize(1180, 800);
        frame.setMinimumSize(new Dimension(980, 680));
        frame.setLocationRelativeTo(null);
        frame.addWindowListener(new WindowAdapter() {
            @Override
            public void windowClosing(WindowEvent e) {
                if (busy) {
                    int r = JOptionPane.showConfirmDialog(frame, "正在下载，确定要退出吗？", "确认退出",
                            JOptionPane.YES_NO_OPTION, JOptionPane.WARNING_MESSAGE);
                    if (r != JOptionPane.YES_OPTION) {
                        return;
                    }
                    Installer ins = installer;
                    if (ins != null) {
                        ins.cancel();
                    }
                    Cancel pack = packCancel;
                    if (pack != null) {
                        pack.cancel();
                    }
                }
                frame.dispose();
                System.exit(0);
            }
        });
        frame.setVisible(true);
        if (mainSplit != null) {
            mainSplit.setDividerLocation(0.56);
        }
        loadManifest();
        scanJava();
        detectDirs(true);
        clipTimer = new javax.swing.Timer(1200, e -> checkClipboard());
        clipTimer.setInitialDelay(1500);
        clipTimer.start();
        try {
            if (java.nio.file.Files.isRegularFile(Modpack.keyFile())) {
                cfKeyField.setText(java.nio.file.Files.readString(Modpack.keyFile()).trim());
            }
        } catch (Exception ignored) {
            // 读不到就算了
        }
    }

    private JPanel buildContent() {
        JPanel root = new JPanel(new BorderLayout());
        root.setBackground(Theme.BG);
        JPanel north = new JPanel(new BorderLayout());
        north.setBackground(Theme.BG);
        north.add(buildHeader(), BorderLayout.NORTH);
        north.add(buildClipBar(), BorderLayout.SOUTH);
        root.add(north, BorderLayout.NORTH);
        root.add(buildBody(), BorderLayout.CENTER);
        root.add(buildStatusBar(), BorderLayout.SOUTH);
        return root;
    }

    private JPanel buildClipBar() {
        clipBar = new JPanel(new BorderLayout(8, 4));
        clipBar.setOpaque(true);
        clipBar.setBackground(new java.awt.Color(0x1F2E45));
        clipBar.setBorder(Theme.padding(6, 16, 6, 16));
        clipLabel = new JLabel();
        clipLabel.setFont(Theme.font(Font.PLAIN, 12));
        clipLabel.setForeground(Theme.ACCENT);
        clipBar.add(clipLabel, BorderLayout.CENTER);
        JPanel clipActions = new JPanel(new java.awt.FlowLayout(java.awt.FlowLayout.RIGHT, 6, 0));
        clipActions.setOpaque(false);
        JButton clipImport = Theme.button("导入");
        JButton clipIgnore = Theme.button("忽略");
        clipImport.addActionListener(e -> {
            hideClipBar();
            importLink(clipUrl);
        });
        clipIgnore.addActionListener(e -> {
            dismissedClip = clipUrl == null ? "" : clipUrl;
            hideClipBar();
        });
        clipActions.add(clipImport);
        clipActions.add(clipIgnore);
        clipBar.add(clipActions, BorderLayout.EAST);
        clipBar.setVisible(false);
        return clipBar;
    }

    private JPanel buildHeader() {
        JPanel header = new JPanel(new BorderLayout(0, 8));
        header.setBackground(Theme.BG);
        header.setBorder(Theme.padding(14, 16, 10, 16));

        JPanel titles = new JPanel();
        titles.setOpaque(false);
        titles.setLayout(new BoxLayout(titles, BoxLayout.Y_AXIS));
        JLabel title = new JLabel("MCDL");
        title.setFont(Theme.font(Font.BOLD, 22));
        title.setForeground(Theme.TEXT);
        JLabel sub = new JLabel("Minecraft 原版 / 整合包安装器 · 直接写入 .minecraft，装完即可用 PCL2 / HMCL 启动");
        sub.setFont(Theme.font(Font.PLAIN, 12));
        sub.setForeground(Theme.MUTED);
        titles.add(title);
        titles.add(sub);
        header.add(titles, BorderLayout.NORTH);

        JPanel row = new JPanel(new BorderLayout(8, 0));
        row.setOpaque(false);
        JLabel lab = new JLabel("安装目录");
        lab.setForeground(Theme.MUTED);
        lab.setFont(Theme.font(Font.PLAIN, 12));
        row.add(lab, BorderLayout.WEST);

        dirBox.setEditable(true);
        dirBox.setMinimumSize(new Dimension(120, 28));
        dirBox.setPreferredSize(new Dimension(320, 28));
        dirBox.setFont(Theme.font(Font.PLAIN, 13));
        dirBox.getEditor().setItem(initialDir.toString());
        dirBox.addActionListener(e -> {
            if (!updatingDirBox) {
                        refreshTable();
                updateSelection();
            }
        });
        row.add(dirBox, BorderLayout.CENTER);

        JPanel right = new JPanel(new java.awt.FlowLayout(java.awt.FlowLayout.RIGHT, 6, 0));
        right.setOpaque(false);
        browseBtn.addActionListener(e -> chooseDir());
        right.add(browseBtn);
        detectBtn.setToolTipText("自动识别 PCL / HMCL 使用的游戏目录");
        detectBtn.addActionListener(e -> detectDirs());
        right.add(detectBtn);

        JLabel src = new JLabel("下载源");
        src.setForeground(Theme.MUTED);
        src.setFont(Theme.font(Font.PLAIN, 12));
        right.add(src);
        sourceBox.setSelectedItem(initialSource);
        sourceBox.setPreferredSize(new Dimension(140, 28));
        sourceBox.setMinimumSize(new Dimension(110, 28));
        sourceBox.addActionListener(e -> {
            if (manifest != null && !busy) {
                loadManifest();
            }
        });
        right.add(sourceBox);
        mirrorBtn.setPreferredSize(new Dimension(78, 28));
        mirrorBtn.setToolTipText("管理自定义镜像源并查看延迟/成功率");
        mirrorBtn.addActionListener(e -> openMirrorDialog());
        right.add(mirrorBtn);
        refreshBtn.addActionListener(e -> loadManifest(true));
        right.add(refreshBtn);
        row.add(right, BorderLayout.EAST);

        header.add(row, BorderLayout.CENTER);
        return header;
    }

    private JSplitPane buildBody() {
        JSplitPane split = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT, buildLeft(), buildRight());
        mainSplit = split;
        split.setBorder(BorderFactory.createEmptyBorder(0, 10, 0, 10));
        split.setResizeWeight(0.55);
        split.setDividerLocation(600);
        split.setBackground(Theme.BG);
        return split;
    }

    private JPanel buildLeft() {
        JPanel left = new JPanel(new BorderLayout(0, 8));
        left.setBackground(Theme.BG);

        JPanel filters = new JPanel(new BorderLayout(8, 0));
        filters.setOpaque(false);
        searchField.setToolTipText("搜索版本号，例如 1.20 / 26.");
        searchField.setFont(Theme.font(Font.PLAIN, 13));
        searchField.getDocument().addDocumentListener(new javax.swing.event.DocumentListener() {
            @Override
            public void insertUpdate(javax.swing.event.DocumentEvent e) {
                applyFilter();
            }

            @Override
            public void removeUpdate(javax.swing.event.DocumentEvent e) {
                applyFilter();
            }

            @Override
            public void changedUpdate(javax.swing.event.DocumentEvent e) {
                applyFilter();
            }
        });
        filters.add(searchField, BorderLayout.CENTER);
        typeBox.setPreferredSize(new Dimension(110, 28));
        typeBox.addActionListener(e -> applyFilter());
        filters.add(typeBox, BorderLayout.EAST);
        JPanel filterWrap = new JPanel(new BorderLayout());
        filterWrap.setOpaque(false);
        filterWrap.add(filters, BorderLayout.CENTER);
        filterWrap.setBorder(Theme.padding(0, 4, 6, 4));
        left.add(filterWrap, BorderLayout.NORTH);

        table.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        table.setRowHeight(27);
        table.setShowGrid(false);
        table.setFillsViewportHeight(true);
        table.setBackground(Theme.PANEL);
        table.getTableHeader().setReorderingAllowed(false);
        table.getTableHeader().setPreferredSize(new Dimension(0, 30));
        table.getColumnModel().getColumn(0).setPreferredWidth(180);
        table.getColumnModel().getColumn(1).setPreferredWidth(90);
        table.getColumnModel().getColumn(2).setPreferredWidth(110);
        table.getColumnModel().getColumn(3).setPreferredWidth(70);
        table.getColumnModel().getColumn(4).setPreferredWidth(100);
        table.setDefaultRenderer(String.class, new RowRenderer());
        table.getSelectionModel().addListSelectionListener(e -> {
            if (!e.getValueIsAdjusting()) {
                updateSelection();
            }
        });
        table.addMouseListener(new MouseAdapter() {
            @Override
            public void mouseClicked(MouseEvent e) {
                int viewRow = table.rowAtPoint(e.getPoint());
                int viewCol = table.columnAtPoint(e.getPoint());
                if (viewRow >= 0 && viewCol == 4) {
                    VersionTableModel.Row r = model.get(viewRow);
                    if (r.installed && r.dir != null) {
                        openInstanceFolder(r.dir);
                    }
                    return;
                }
                if (e.getClickCount() == 2) {
                    installSelected();
                }
            }
        });

        JScrollPane scroll = new JScrollPane(table);
        scroll.setBorder(BorderFactory.createLineBorder(Theme.BORDER));
        scroll.getViewport().setBackground(Theme.PANEL);

        // 列表为空时显示提示（加载中 / 没有匹配），有数据时切回表格
        emptyLabel.setHorizontalAlignment(JLabel.CENTER);
        emptyLabel.setFont(Theme.font(Font.PLAIN, 13));
        emptyLabel.setForeground(Theme.MUTED);
        emptyLabel.setText("正在获取版本列表…");
        JPanel emptyPanel = new JPanel(new BorderLayout());
        emptyPanel.setBackground(Theme.PANEL);
        emptyPanel.setBorder(BorderFactory.createLineBorder(Theme.BORDER));
        emptyPanel.add(emptyLabel, BorderLayout.CENTER);

        listCards = new JPanel(new java.awt.CardLayout());
        listCards.setOpaque(false);
        listCards.add(emptyPanel, "empty");
        listCards.add(scroll, "table");
        ((java.awt.CardLayout) listCards.getLayout()).show(listCards, "empty");
        left.add(listCards, BorderLayout.CENTER);
        return left;
    }

    private JPanel buildRight() {
        JPanel right = new JPanel(new BorderLayout(0, 10));
        right.setBackground(Theme.BG);
        right.setMinimumSize(new Dimension(300, 0));
        right.setBorder(BorderFactory.createEmptyBorder(0, 14, 0, 2));

        JPanel top = new JPanel();
        top.setOpaque(false);
        top.setLayout(new BoxLayout(top, BoxLayout.Y_AXIS));



        selectedLabel.setAlignmentX(java.awt.Component.LEFT_ALIGNMENT);
        detailLabel.setAlignmentX(java.awt.Component.LEFT_ALIGNMENT);
        selectedLabel.setFont(Theme.font(Font.BOLD, 16));
        selectedLabel.setForeground(Theme.TEXT);
        detailLabel.setFont(Theme.font(Font.PLAIN, 12));
        detailLabel.setForeground(Theme.MUTED);
        top.add(selectedLabel);
        top.add(Box.createVerticalStrut(3));
        top.add(detailLabel);
        top.add(Box.createVerticalStrut(12));

        JPanel options = new JPanel(new GridBagLayout());
        options.setAlignmentX(java.awt.Component.LEFT_ALIGNMENT);
        options.setOpaque(false);
        GridBagConstraints gc = new GridBagConstraints();
        gc.insets = new Insets(3, 0, 3, 10);
        gc.anchor = GridBagConstraints.WEST;
        gc.gridx = 0;
        gc.gridy = 0;
        JLabel jobsLabel = new JLabel("并发下载数");
        jobsLabel.setForeground(Theme.MUTED);
        options.add(jobsLabel, gc);
        gc.gridx = 1;
        gc.weightx = 1;
        jobsSpinner.setPreferredSize(new Dimension(80, 28));
        jobsSpinner.setToolTipText("BMCLAPI 建议不超过 32，过高会被限速");
        options.add(jobsSpinner, gc);
        gc.weightx = 0;

        gc.gridx = 0;
        gc.gridy = 1;
        gc.gridwidth = 3;
        options.add(verifyBox, gc);
        gc.gridy = 2;
        options.add(assetsBox, gc);

        gc.gridy = 3;
        gc.gridwidth = 1;
        gc.gridx = 0;
        JLabel javaLabel = new JLabel("Java 运行时");
        javaLabel.setForeground(Theme.MUTED);
        options.add(javaLabel, gc);
        gc.gridx = 1;
        gc.weightx = 1;
        javaBox.setPreferredSize(new Dimension(250, 28));
        javaBox.setMinimumSize(new Dimension(160, 28));
        javaBox.setToolTipText("自动模式会按所选版本的要求，从本机已安装的 Java 里挑最合适的");
        javaBox.addActionListener(e -> {
            if (!updatingJavaBox) {
                updateJavaHint();
            }
        });
        options.add(javaBox, gc);
        gc.gridx = 2;
        gc.weightx = 0;
        scanJavaBtn.setToolTipText("重新扫描注册表、PATH、常见安装目录和启动器自带运行时");
        scanJavaBtn.addActionListener(e -> scanJava());
        options.add(scanJavaBtn, gc);

        gc.gridy = 4;
        gc.gridx = 0;
        gc.gridwidth = 3;
        javaDetail.setFont(Theme.font(Font.PLAIN, 11));
        javaDetail.setForeground(Theme.MUTED);
        options.add(javaDetail, gc);

        top.add(options);
        top.add(Box.createVerticalStrut(10));

        JPanel buttons = new JPanel(new BorderLayout(8, 0));
        buttons.setAlignmentX(java.awt.Component.LEFT_ALIGNMENT);
        buttons.setOpaque(false);
        installBtn.setPreferredSize(new Dimension(0, 40));
        installBtn.addActionListener(e -> installSelected());
        buttons.add(installBtn, BorderLayout.CENTER);
        cancelBtn.setEnabled(false);
        cancelBtn.addActionListener(e -> cancelInstall());
        buttons.add(cancelBtn, BorderLayout.EAST);
        top.add(buttons);

        JPanel extra = new JPanel(new BorderLayout(8, 0));
        extra.setAlignmentX(java.awt.Component.LEFT_ALIGNMENT);
        extra.setOpaque(false);
        packBtn.setToolTipText("导入 Modrinth .mrpack 整合包，自动装原版、加载器、mods 和配置");
        packBtn.addActionListener(e -> importPack());
        extra.add(packBtn, BorderLayout.WEST);
        openBtn.addActionListener(e -> openGameDir());
        extra.add(openBtn, BorderLayout.EAST);
        top.add(Box.createVerticalStrut(8));
        top.add(extra);

        JPanel keyRow = new JPanel(new BorderLayout(6, 0));
        keyRow.setAlignmentX(java.awt.Component.LEFT_ALIGNMENT);
        keyRow.setOpaque(false);
        JLabel keyLabel = new JLabel("CF Key");
        keyLabel.setForeground(Theme.MUTED);
        keyLabel.setFont(Theme.font(Font.PLAIN, 11));
        keyRow.add(keyLabel, BorderLayout.WEST);
        cfKeyField.setFont(Theme.font(Font.PLAIN, 11));
        cfKeyField.setToolTipText("CurseForge API key，仅 CurseForge 整合包需要");
        keyRow.add(cfKeyField, BorderLayout.CENTER);
        cfTestBtn.setFont(Theme.font(Font.PLAIN, 11));
        cfTestBtn.setToolTipText("调用 CurseForge API 轻量接口验证 key");
        cfTestBtn.addActionListener(e -> testCfKey());
        keyRow.add(cfTestBtn, BorderLayout.EAST);
        top.add(keyRow);
        cfKeyHint.setFont(Theme.font(Font.PLAIN, 10));
        cfKeyHint.setForeground(Theme.MUTED);
        cfKeyHint.setAlignmentX(java.awt.Component.LEFT_ALIGNMENT);
        top.add(cfKeyHint);
        JLabel dropHint = new JLabel("可将 .mrpack / 整合包 zip 拖入窗口导入");
        dropHint.setFont(Theme.font(Font.PLAIN, 10));
        dropHint.setForeground(Theme.MUTED);
        dropHint.setAlignmentX(java.awt.Component.LEFT_ALIGNMENT);
        top.add(dropHint);
        right.add(top, BorderLayout.NORTH);

        logArea.setEditable(false);
        logArea.setLineWrap(true);
        logArea.setWrapStyleWord(true);
        logArea.setFont(Theme.font(Font.PLAIN, 12));
        logArea.setBackground(Theme.PANEL);
        logArea.setForeground(new Color(0xB9BEC7));
        JScrollPane logScroll = new JScrollPane(logArea);
        logScroll.setBorder(BorderFactory.createTitledBorder(
                BorderFactory.createLineBorder(Theme.BORDER), " 日志 ",
                0, 0, Theme.font(Font.PLAIN, 11), Theme.MUTED));
        logScroll.getViewport().setBackground(Theme.PANEL);
        right.add(logScroll, BorderLayout.CENTER);

        JPanel bottom = new JPanel(new BorderLayout(0, 4));
        bottom.setOpaque(false);
        progress.setStringPainted(true);
        progress.setString("0%");
        progress.setPreferredSize(new Dimension(0, 20));
        progress.setBorderPainted(true);
        progress.setBorder(BorderFactory.createLineBorder(Theme.BORDER));
        bottom.add(progress, BorderLayout.NORTH);
        JPanel line = new JPanel(new BorderLayout());
        line.setOpaque(false);
        statusLabel.setFont(Theme.font(Font.PLAIN, 12));
        statusLabel.setForeground(Theme.MUTED);
        speedLabel.setFont(Theme.font(Font.PLAIN, 12));
        speedLabel.setForeground(Theme.GREEN);
        line.add(statusLabel, BorderLayout.WEST);
        line.add(speedLabel, BorderLayout.EAST);
        bottom.add(line, BorderLayout.CENTER);
        right.add(bottom, BorderLayout.SOUTH);
        return right;
    }

    private JPanel buildStatusBar() {
        JPanel bar = new JPanel(new BorderLayout());
        bar.setBackground(Theme.PANEL);
        bar.setBorder(Theme.padding(5, 14, 5, 14));
        JLabel left = new JLabel("就绪");
        left.setFont(Theme.font(Font.PLAIN, 11));
        left.setForeground(Theme.MUTED);
        JLabel right = new JLabel("支持原版、Forge / NeoForge / Fabric / Quilt 与 Modrinth / CurseForge 整合包");
        right.setFont(Theme.font(Font.PLAIN, 11));
        right.setForeground(Theme.MUTED);
        bar.add(left, BorderLayout.WEST);
        bar.add(right, BorderLayout.EAST);
        this.statusBarLabel = left;
        return bar;
    }

    private JLabel statusBarLabel;

    private void loadManifest() {
        loadManifest(false);
    }

    private void loadManifest(boolean forceRefresh) {
        if (busy) {
            return;
        }
        final Sources.Source source = (Sources.Source) sourceBox.getSelectedItem();
        refreshBtn.setEnabled(false);
        status("正在获取版本列表（" + source.label + "）…");
        showEmpty("正在获取版本列表…");
        new SwingWorker<Manifest.Data, Void>() {
            @Override
            protected Manifest.Data doInBackground() throws Exception {
                return Manifest.fetch(source, s -> {
                    // 测速信息等日志直接写到日志区
                }, forceRefresh);
            }

            @Override
            protected void done() {
                refreshBtn.setEnabled(true);
                try {
                    Manifest.Data data = get();
                    manifest = data;
                    applyFilter();
                    status("共 " + data.versions.size() + " 个版本；最新正式版 "
                            + data.latestRelease
                            + (data.fromCache ? "（本地缓存）" : "，" + Sources.autoChoiceLabel()));
                    appendLog("版本列表已刷新：" + data.versions.size() + " 个（" + source.label
                            + (data.fromCache ? "，来自缓存" : "") + "）");
                } catch (Exception e) {
                    Throwable cause = e.getCause() == null ? e : e.getCause();
                    String msg = cause.getMessage();
                    if (msg == null || msg.isBlank()
                            || msg.contains("timed out") || msg.contains("Connect")
                            || msg.contains("连接")) {
                        msg = "无法连接网络或镜像，请检查网络或「镜像源」设置";
                    }
                    status("获取版本列表失败：" + msg);
                    appendLog("获取版本列表失败：" + msg);
                    showEmpty("获取版本列表失败：" + msg + "（点右上角「刷新列表」重试）");
                }
            }
        }.execute();
    }

    /** 在「空状态提示」和「表格」之间切换。 */
    private void showEmpty(String text) {
        if (listCards == null) {
            return;
        }
        emptyLabel.setText(text);
        ((java.awt.CardLayout) listCards.getLayout()).show(listCards, "empty");
    }

    private void showTable() {
        if (listCards == null) {
            return;
        }
        ((java.awt.CardLayout) listCards.getLayout()).show(listCards, "table");
    }

    private void applyFilter() {
        String q = searchField.getText() == null ? "" : searchField.getText().trim().toLowerCase(Locale.ROOT);
        String type = (String) typeBox.getSelectedItem();

        java.util.Map<String, Path> local = scanLocalVersions();
        List<VersionTableModel.Row> rows = new ArrayList<>();

        Manifest.Data data = manifest;
        if (data != null) {
            for (Manifest.RemoteVersion v : data.versions) {
                boolean installed = local.containsKey(v.id);
                if (!installed) {
                    boolean typeOk = switch (type == null ? "全部" : type) {
                        case "正式版" -> "release".equals(v.type);
                        case "快照" -> "snapshot".equals(v.type);
                        case "远古" -> v.type != null && v.type.startsWith("old");
                        default -> true;
                    };
                    if (!typeOk) {
                        continue;
                    }
                    if (!q.isEmpty() && !v.id.toLowerCase(Locale.ROOT).contains(q)) {
                        continue;
                    }
                }
                rows.add(new VersionTableModel.Row(v.id, v.typeLabel(), v.dateLabel(), installed,
                        installed ? local.get(v.id) : null, false, v));
            }
        }

        // 只存在于 versions 目录的实例（整合包、手动安装）
        for (java.util.Map.Entry<String, Path> e : local.entrySet()) {
            boolean known = false;
            if (data != null) {
                for (Manifest.RemoteVersion v : data.versions) {
                    if (v.id.equals(e.getKey())) {
                        known = true;
                        break;
                    }
                }
            }
            if (!known) {
                rows.add(new VersionTableModel.Row(e.getKey(), "整合包 / 本地",
                        dateOf(e.getValue()), true, e.getValue(), true, null));
            }
        }

        // 已安装置顶，其次按发布时间倒序
        rows.sort(java.util.Comparator
                .comparing((VersionTableModel.Row r) -> !r.installed)
                .thenComparing((VersionTableModel.Row r) -> r.date, java.util.Comparator.reverseOrder())
                .thenComparing(r -> r.id, java.util.Comparator.reverseOrder()));

        model.setRows(rows);
        if (rows.isEmpty()) {
            showEmpty("没有匹配的版本（换个关键词或类型试试）");
        } else {
            showTable();
        }
        updateSelection();
        if (!rows.isEmpty() && table.getSelectedRow() < 0) {
            table.setRowSelectionInterval(0, 0);
        }
    }

    /** 扫描 versions 目录，返回 id → 目录。 */
    private java.util.Map<String, Path> scanLocalVersions() {
        java.util.Map<String, Path> map = new java.util.LinkedHashMap<>();
        Path versions;
        try {
            versions = currentDir().resolve("versions");
        } catch (RuntimeException e) {
            return map;
        }
        if (!Files.isDirectory(versions)) {
            return map;
        }
        try (java.nio.file.DirectoryStream<Path> ds = Files.newDirectoryStream(versions)) {
            for (Path p : ds) {
                if (!Files.isDirectory(p)) {
                    continue;
                }
                String id = p.getFileName().toString();
                if (Files.isRegularFile(p.resolve(id + ".json"))) {
                    map.put(id, p);
                }
            }
        } catch (java.io.IOException | RuntimeException ignored) {
            // 目录不可读就返回已扫到的
        }
        return map;
    }

    private static String dateOf(Path dir) {
        try {
            return java.time.Instant.ofEpochMilli(Files.getLastModifiedTime(dir).toMillis())
                    .atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString();
        } catch (java.io.IOException e) {
            return "";
        }
    }

    /** 刷新表格（扫描本机 versions + 重新套过滤）。 */
    private void refreshTable() {
        applyFilter();
    }
    private void updateSelection() {
        int row = table.getSelectedRow();
        if (row < 0 || row >= model.size()) {
            selectedLabel.setText("未选择版本");
            detailLabel.setText(" ");
            installBtn.setEnabled(!busy);
            return;
        }
        VersionTableModel.Row r = model.get(row);
        if (r.localOnly) {
            selectedLabel.setText("本地实例：" + r.id);
            detailLabel.setText(r.typeLabel + " · " + r.date + " · " + r.dir);
            installBtn.setEnabled(false);
            ensureLocalJava(r);
            return;
        }
        selectedLabel.setText("已选择：" + r.id);
        String state = r.installed ? " · 本目录已安装（可重下修复）" : "";
        detailLabel.setText(r.typeLabel + " · 发布于 " + r.date + state);
        installBtn.setEnabled(!busy);
        ensureRequiredJava(r.remote);
    }

    /** 本地实例（整合包）直接从版本 JSON 读 Java 要求，不发网络请求。 */
    private void ensureLocalJava(VersionTableModel.Row r) {
        if (r.id.equals(requiredFor)) {
            updateJavaHint();
            return;
        }
        requiredFor = r.id;
        queryingJava = false;
        requiredJava = -1;
        try {
            if (r.dir != null) {
                requiredJava = (int) mcdl.core.Json.parse(r.dir.resolve(r.id + ".json"))
                        .path("javaVersion", "majorVersion").asLong(-1);
            }
        } catch (Exception ignored) {
            requiredJava = -1;
        }
        updateJavaHint();
    }
    /** 选中版本后，异步确认它要求的 Java 版本（版本 JSON 有本地缓存）。 */
    private void ensureRequiredJava(Manifest.RemoteVersion version) {
        if (version.id.equals(requiredFor)) {
            updateJavaHint();
            return;
        }
        requiredFor = version.id;
        requiredJava = -1;
        queryingJava = true;
        updateJavaHint();
        final Sources.Source source = (Sources.Source) sourceBox.getSelectedItem();
        Path mcDirTmp;
        try {
            mcDirTmp = currentDir();
        } catch (RuntimeException ex) {
            mcDirTmp = null;
        }
        final Path mcDir = mcDirTmp;
        new SwingWorker<Integer, Void>() {
            @Override
            protected Integer doInBackground() {
                try {
                    return VersionService.requiredJava(version, source, mcDir, null);
                } catch (Exception e) {
                    return -1;
                }
            }

            @Override
            protected void done() {
                try {
                    queryingJava = false;
                    if (version.id.equals(requiredFor)) {
                        requiredJava = get();
                        updateJavaHint();
                    }
                } catch (Exception ignored) {
                    // 取消或异常时保持未知
                }
            }
        }.execute();
    }

    /** 扫描本机 Java（后台执行，避免卡界面）。 */
    private void scanJava() {
        scanJavaBtn.setEnabled(false);
        scanningJava = true;
        javaDetail.setText("正在扫描本机 Java…");
        new SwingWorker<List<JavaFinder.JavaInfo>, Void>() {
            @Override
            protected List<JavaFinder.JavaInfo> doInBackground() {
                List<JavaFinder.JavaInfo> list = JavaFinder.scan();
                for (JavaFinder.JavaInfo info : list) {
                    JavaFinder.verify(info);
                }
                return list;
            }

            @Override
            protected void done() {
                scanJavaBtn.setEnabled(true);
                scanningJava = false;
                try {
                    javas = get();
                } catch (Exception e) {
                    javas = List.of();
                }
                rebuildJavaBox();
                updateJavaHint();
                appendLog("Java 扫描完成：找到 " + javas.size() + " 个（" + JavaFinder.summary(javas) + "）");
            }
        }.execute();
    }

    /** 重建下拉框：第一项是「自动匹配」，其余是本机 Java。 */
    private void rebuildJavaBox() {
        updatingJavaBox = true;
        try {
            javaBox.removeAllItems();
            javaBox.addItem(new JavaChoice(null));
            for (JavaFinder.JavaInfo info : javas) {
                javaBox.addItem(new JavaChoice(info));
            }
            javaBox.setSelectedIndex(0);
        } finally {
            updatingJavaBox = false;
        }
    }

    private JavaFinder.JavaInfo selectedJava() {
        Object item = javaBox.getSelectedItem();
        if (item instanceof JavaChoice choice) {
            return choice.info;
        }
        return null;
    }

    /** 更新「该版本要什么 Java / 本机有什么 / 自动推荐哪个」。 */
    private void updateJavaHint() {
        if (javas.isEmpty()) {
            if (scanningJava) {
                javaDetail.setText("正在扫描本机 Java…");
            } else {
                javaDetail.setText("没有找到 Java（该版本需要 Java " + requiredText() + "）");
            }
            return;
        }
        String need = requiredJava > 0 ? "需要 Java " + requiredJava
                : (queryingJava ? "Java 要求查询中" : "Java 要求未知");
        JavaFinder.JavaInfo manual = selectedJava();
        JavaFinder.JavaInfo best = manual != null ? manual : JavaFinder.best(javas, requiredJava);
        StringBuilder sb = new StringBuilder(need);
        sb.append(" · 本机 ").append(JavaFinder.summary(javas));
        if (best != null) {
            sb.append(" · ").append(manual != null ? "已选 " : "推荐 ");
            sb.append("Java ").append(best.major);
            sb.append("（").append(JavaFinder.matchLabel(best, requiredJava)).append("）");
            javaDetail.setToolTipText(best.describe());
        } else {
            javaDetail.setToolTipText(null);
        }
        javaDetail.setText(sb.toString());
    }

    private String requiredText() {
        return requiredJava > 0 ? String.valueOf(requiredJava) : "?";
    }

    private boolean isInstalled(String id) {
        try {
            Path base = currentDir();
            return Files.isRegularFile(base.resolve("versions").resolve(id).resolve(id + ".json"));
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** 下拉框里显示的文本 → 目录路径（去掉 "  ·  来源" 后缀）。 */
    private String dirText() {
        Object item = dirBox.isEditable() ? dirBox.getEditor().getItem() : dirBox.getSelectedItem();
        String s = item == null ? "" : item.toString().trim();
        int i = s.indexOf("  ·  ");
        if (i > 0) {
            s = s.substring(0, i).trim();
        }
        return s;
    }

    private Path currentDir() {
        return Paths.get(dirText());
    }

    private void setDirText(String path) {
        dirBox.getEditor().setItem(path);
    }

    /** 后台识别 PCL / HMCL 的游戏目录，填充下拉框。 */
    private void detectDirs() {
        detectDirs(false);
    }

    /**
     * @param initial 启动时自动识别：当前目录不在识别结果里就选第一个；
     *                用户点「识别目录」时则保留手填/已选目录，不再强行重置到第一项。
     */
    private void detectDirs(boolean initial) {
        detectBtn.setEnabled(false);
        new SwingWorker<List<LauncherDirs.DirInfo>, Void>() {
            @Override
            protected List<LauncherDirs.DirInfo> doInBackground() {
                return LauncherDirs.detect();
            }

            @Override
            protected void done() {
                detectBtn.setEnabled(true);
                List<LauncherDirs.DirInfo> dirs;
                try {
                    dirs = get();
                } catch (Exception e) {
                    dirs = List.of();
                }
                if (dirs.isEmpty()) {
                    return;
                }
                String keep = dirText();
                updatingDirBox = true;
                try {
                    dirBox.removeAllItems();
                    for (LauncherDirs.DirInfo d : dirs) {
                        dirBox.addItem(d.label());
                    }
                    int index = -1;
                    for (int i = 0; i < dirs.size(); i++) {
                        if (dirs.get(i).dir.toString().equalsIgnoreCase(keep)) {
                            index = i;
                            break;
                        }
                    }
                    if (index >= 0) {
                        dirBox.setSelectedIndex(index);
                    } else if (initial && !initialDirExplicit) {
                        dirBox.setSelectedIndex(0);
                    } else if (keep.isBlank()) {
                        dirBox.setSelectedIndex(0);
                    } else {
                        // 用户手填/浏览选择/命令行 --dir 的目录不在识别结果里：保留它，别覆盖
                        dirBox.getEditor().setItem(keep);
                    }
                } finally {
                    updatingDirBox = false;
                }
                refreshTable();
                updateSelection();
                appendLog("识别到 " + dirs.size() + " 个游戏目录，当前使用：" + currentDir());
            }
        }.execute();
    }

    /** 导入 Modrinth .mrpack。 */
    private boolean pickingPack;

    private void importPack() {
        if (busy || pickingPack) {
            return;
        }
        pickingPack = true;
        status("正在打开系统文件对话框…");
        new Thread(() -> {
            java.io.File picked = null;
            String reason = null;
            try {
                picked = NativeDialog.openFile(frame, "选择整合包",
                        "整合包 (*.mrpack;*.zip)|*.mrpack;*.zip|所有文件 (*.*)|*.*",
                        System.getProperty("user.home") + java.io.File.separator + "Downloads");
                reason = NativeDialog.lastError();
            } catch (RuntimeException | Error e) {
                reason = "系统文件对话框异常：" + e.getMessage();
            }
            final java.io.File result = picked;
            final String err = reason;
            SwingUtilities.invokeLater(() -> {
                pickingPack = false;
                if (result != null) {
                    beginImport(result);
                    return;
                }
                if (err == null) {
                    status("已取消导入");
                    return;
                }
                appendLog("系统文件对话框不可用，回退 JFileChooser：" + err);
                importPackFallback();
            });
        }, "mcdl-choose-pack").start();
    }

    private void importPackFallback() {
        JFileChooser chooser = new JFileChooser();
        chooser.setDialogTitle("选择整合包");
        chooser.setFileFilter(new javax.swing.filechooser.FileNameExtensionFilter(
                "整合包 (*.mrpack, *.zip)", "mrpack", "zip"));
        try {
            chooser.setCurrentDirectory(new java.io.File(System.getProperty("user.home"), "Downloads"));
        } catch (RuntimeException ignored) {
            // 默认目录不存在就算了
        }
        if (chooser.showOpenDialog(frame) == JFileChooser.APPROVE_OPTION) {
            beginImport(chooser.getSelectedFile());
        }
    }
    /** 从文件开始导入（选择器与拖拽共用）。 */
    private void beginImport(java.io.File file) {
        beginImport(file, null);
    }

    /** 从文件开始导入，可指定建议实例名。 */
    private void beginImport(java.io.File file, String suggested) {
        if (busy) {
            return;
        }
        String base = suggested != null && !suggested.isBlank()
                ? suggested
                : file.getName().replaceAll("(?i)\\.(mrpack|zip)$", "");
        String name = (String) JOptionPane.showInputDialog(frame, "实例名：", "导入整合包",
                JOptionPane.QUESTION_MESSAGE, null, null, base);
        if (name == null || name.isBlank()) {
            return;
        }
        Path dir;
        try {
            dir = currentDir();
        } catch (RuntimeException e) {
            status("安装目录不合法");
            return;
        }
        String key = cfKeyField.getText() == null ? "" : cfKeyField.getText().trim();
        if (!key.isEmpty()) {
            Modpack.saveKey(key);
        }
        final String instanceName = name.trim();
        final String cfKey = key;
        final Cancel token = new Cancel();
        packCancel = token;
        setBusy(true);
        status("正在读取整合包信息…");
        new Thread(() -> {
            try {
                Modpack.Preflight pf = Modpack.preflight(file.toPath(), dir);
                SwingUtilities.invokeLater(() -> {
                    if (token.isCancelled()) {
                        finishCancelled();
                        return;
                    }
                    setBusy(false);
                    showPreflight(pf, file, dir, instanceName, cfKey, token);
                });
            } catch (Throwable t) {
                String msg = t.getMessage() == null ? t.toString() : t.getMessage();
                SwingUtilities.invokeLater(() -> {
                    packCancel = null;
                    setBusy(false);
                    status("读取整合包失败：" + msg);
                    appendLog("读取整合包失败：" + msg);
                    JOptionPane.showMessageDialog(frame, "读取整合包失败：\n" + msg,
                            "导入失败", JOptionPane.ERROR_MESSAGE);
                });
            }
        }, "mcdl-preflight").start();
    }

    /** 展示预检卡片；确认后才开始安装。 */
    private void showPreflight(Modpack.Preflight pf, java.io.File file, Path dir,
                               String instanceName, String cfKey, Cancel token) {
        Modpack.Summary s = pf.summary;
        String loader = switch (s.loader) {
            case "fabric-loader" -> "Fabric";
            case "quilt-loader" -> "Quilt";
            case "forge" -> "Forge";
            case "neoforge" -> "NeoForge";
            default -> "原版";
        };
        String size = s.downloadBytes > 0 ? Installer.human(s.downloadBytes) + "（约）" : "未知（需 CurseForge API 解析）";
        String time = "";
        if (s.downloadBytes > 0) {
            long seconds = Math.max(1, s.downloadBytes / (300L * 1024L));
            time = "，按 300 KB/s 约 " + (seconds / 60) + " 分 " + (seconds % 60) + " 秒";
        }
        StringBuilder html = new StringBuilder("<html>");
        html.append("<b>").append(s.format).append(" 整合包</b>：").append(escapeHtml(s.packName));
        if (!s.packVersion.isBlank()) {
            html.append(" ").append(escapeHtml(s.packVersion));
        }
        html.append("<br><br>");
        html.append("Minecraft：").append(escapeHtml(s.mcVersion)).append("<br>");
        html.append("加载器：").append(loader);
        if (!s.loaderVersion.isBlank()) {
            html.append(" ").append(escapeHtml(s.loaderVersion));
        }
        html.append("<br>");
        html.append("文件数量：").append(s.fileCount).append("<br>");
        html.append("预计下载：").append(size).append(time).append("<br>");
        html.append("overrides：").append(Installer.human(s.overridesBytes)).append("<br>");
        html.append("安装到：").append(escapeHtml(dir.toString())).append("<br>");
        if (pf.requiredBytes > 0) {
            html.append("所需空间（1.5 倍）：").append(Installer.human(pf.requiredBytes))
                    .append("，剩余 ").append(Installer.human(pf.usableBytes)).append("<br>");
        }
        if (!pf.warnings.isEmpty()) {
            html.append("<br><b>注意：</b><ul>");
            for (String w : pf.warnings) {
                html.append("<li>").append(escapeHtml(w)).append("</li>");
            }
            html.append("</ul>");
        }
        html.append("<br>确认开始导入吗？</html>");

        if (pf.blocked) {
            packCancel = null;
            JOptionPane.showMessageDialog(frame, html.toString(), "无法开始导入",
                    JOptionPane.ERROR_MESSAGE);
            return;
        }
        int r = JOptionPane.showConfirmDialog(frame, html.toString(), "导入前确认",
                JOptionPane.OK_CANCEL_OPTION, JOptionPane.INFORMATION_MESSAGE);
        if (r == JOptionPane.OK_OPTION) {
            startPackImport(file.toPath(), dir, instanceName, cfKey, false, token);
        } else {
            packCancel = null;
        }
    }

    /** 定时检查剪贴板里的整合包链接，命中时显示提示条。 */
    private void checkClipboard() {
        if (busy) {
            return;
        }
        String text;
        try {
            Object data = java.awt.Toolkit.getDefaultToolkit().getSystemClipboard()
                    .getData(java.awt.datatransfer.DataFlavor.stringFlavor);
            text = data == null ? "" : data.toString();
        } catch (Exception e) {
            return;
        }
        if (text.equals(lastClipText)) {
            return;
        }
        lastClipText = text;
        String url = ModpackLink.findUrl(text);
        if (url == null || url.equals(dismissedClip)) {
            hideClipBar();
            return;
        }
        clipUrl = url;
        clipLabel.setText("检测到链接，导入？  " + shorten(url, 72));
        clipBar.setVisible(true);
        if (clipBar.getParent() != null) {
            clipBar.getParent().revalidate();
            clipBar.getParent().repaint();
        }
    }

    private void hideClipBar() {
        if (clipBar != null) {
            clipBar.setVisible(false);
            if (clipBar.getParent() != null) {
                clipBar.getParent().revalidate();
            }
        }
    }

    private static String shorten(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }

    /** 解析链接、下载到临时目录，然后走导入流程。 */
    private void importLink(String url) {
        if (busy || url == null) {
            return;
        }
        setBusy(true);
        status("正在解析链接…");
        appendLog("链接：" + url);
        new Thread(() -> {
            try {
                ModpackLink.Resolved resolved = ModpackLink.resolve(url, this::appendLog);
                appendLog("解析到整合包：" + resolved.fileName);
                Path file = ModpackLink.download(resolved, this::appendLog);
                SwingUtilities.invokeLater(() -> {
                    setBusy(false);
                    beginImport(file.toFile(), resolved.suggestedName);
                });
            } catch (Throwable t) {
                String msg = t.getMessage() == null ? t.toString() : t.getMessage();
                SwingUtilities.invokeLater(() -> {
                    setBusy(false);
                    status("链接导入失败：" + msg);
                    appendLog("链接导入失败：" + msg);
                    JOptionPane.showMessageDialog(frame, "链接导入失败：\n" + msg,
                            "导入失败", JOptionPane.ERROR_MESSAGE);
                });
            }
        }, "mcdl-link").start();
    }

    /** 给窗口内所有组件安装文件拖拽处理，拖入 .mrpack/.zip 即导入。 */
    private void installDropSupport() {
        javax.swing.TransferHandler handler = new javax.swing.TransferHandler() {
            @Override
            public boolean canImport(TransferSupport support) {
                return !busy && support.isDataFlavorSupported(
                        java.awt.datatransfer.DataFlavor.javaFileListFlavor);
            }

            @Override
            public boolean importData(TransferSupport support) {
                if (!canImport(support)) {
                    return false;
                }
                try {
                    @SuppressWarnings("unchecked")
                    java.util.List<java.io.File> files = (java.util.List<java.io.File>)
                            support.getTransferable().getTransferData(
                                    java.awt.datatransfer.DataFlavor.javaFileListFlavor);
                    for (java.io.File f : files) {
                        String n = f.getName().toLowerCase(java.util.Locale.ROOT);
                        if (n.endsWith(".mrpack") || n.endsWith(".zip")) {
                            beginImport(f);
                            return true;
                        }
                    }
                } catch (Exception ignored) {
                    // 拖拽内容解析失败
                }
                return false;
            }
        };
        attachHandler(frame.getContentPane(), handler);
        frame.setTransferHandler(handler);
    }

    private void attachHandler(java.awt.Container container, javax.swing.TransferHandler handler) {
        for (java.awt.Component child : container.getComponents()) {
            // 文本框/编辑框必须保留默认 TransferHandler：换成只认文件列表的 handler
            // 会让 Ctrl+V/Ctrl+X/Ctrl+C 全部失效（JDK 17 的文本组件会走 TransferHandler）。
            if (child instanceof javax.swing.JComponent jc
                    && !(child instanceof javax.swing.text.JTextComponent)) {
                jc.setTransferHandler(handler);
            }
            if (child instanceof java.awt.Container ct) {
                attachHandler(ct, handler);
            }
        }
    }

    /** 后台执行导入；如果是 key 问题，先弹窗让用户填，再自动重试一次。 */
    private void startPackImport(Path pack, Path dir, String name, String key, boolean retried,
                                 Cancel token) {
        lastPackFile = pack;
        lastPackDir = dir;
        lastPackName = name;
        lastPackKey = key;
        packCancel = token;
        setBusy(true);
        progress.setIndeterminate(true);
        status("正在导入整合包…");
        appendLog("开始导入整合包：" + pack);
        new Thread(() -> {
            try {
                Modpack.Result result = Modpack.install(pack, dir, name,
                        ((Number) jobsSpinner.getValue()).intValue(), key, token, this::appendLog);
                SwingUtilities.invokeLater(() -> finishPack(result, null));
            } catch (Throwable t) {
                SwingUtilities.invokeLater(() -> {
                    if (token.isCancelled()) {
                        finishCancelled();
                        return;
                    }
                    if (!retried && isKeyError(t)) {
                        String newKey = promptKey(t.getMessage(), key);
                        if (newKey != null) {
                            startPackImport(pack, dir, name, newKey, true, token);
                            return;
                        }
                    }
                    finishPack(null, t);
                });
            }
        }, "mcdl-pack").start();
    }

    private boolean isKeyError(Throwable t) {
        String msg = t.getMessage() == null ? "" : t.getMessage();
        return msg.contains("API key") || msg.contains("key 无效") || msg.contains("免 key 镜像");
    }

    /** 导入失败后弹窗填 key；返回 null 表示用户取消。 */
    private String promptKey(String reason, String current) {
        JPanel panel = new JPanel(new BorderLayout(0, 8));
        JLabel tip = new JLabel("<html>这个整合包需要 CurseForge API key。<br>"
                + "到 <b>console.curseforge.com</b> → <b>API Keys</b> 创建后粘贴到这里。<br>"
                + "<span style='color:gray'>key 会保存在本机，下次自动使用；不会上传。</span></html>");
        panel.add(tip, BorderLayout.NORTH);
        JTextField input = new JTextField(current == null ? "" : current, 42);
        panel.add(input, BorderLayout.CENTER);
        if (reason != null && !reason.isBlank()) {
            JLabel err = new JLabel("<html><span style='color:#c0392b'>" + escapeHtml(reason) + "</span></html>");
            err.setFont(Theme.font(Font.PLAIN, 11));
            panel.add(err, BorderLayout.SOUTH);
        }
        int r = JOptionPane.showConfirmDialog(frame, panel, "填写 CurseForge API Key",
                JOptionPane.OK_CANCEL_OPTION, JOptionPane.QUESTION_MESSAGE);
        if (r != JOptionPane.OK_OPTION || input.getText() == null || input.getText().isBlank()) {
            return null;
        }
        String key = input.getText().trim();
        Modpack.saveKey(key);
        cfKeyField.setText(key);
        return key;
    }

    private static String escapeHtml(String s) {
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    private void finishPack(Modpack.Result result, Throwable error) {
        if (error instanceof Cancel.Cancelled) {
            finishCancelled();
            return;
        }
        packCancel = null;
        progress.setIndeterminate(false);
        progress.setValue(0);
        setBusy(false);
        if (result == null) {
            String msg = error == null ? "未知错误" : error.getMessage();
            status("整合包导入失败：" + msg);
            appendLog("整合包导入失败：" + msg);
            JOptionPane.showMessageDialog(frame, "整合包导入失败：\n" + msg, "导入失败", JOptionPane.ERROR_MESSAGE);
            return;
        }
        refreshTable();
        updateSelection();
        if (result.failedCount > 0) {
            status("整合包已导入，但有 " + result.failedCount + " 个文件失败");
            appendLog("整合包已导入：实例 " + result.instanceName + "（" + result.fileCount
                    + " 个文件，" + result.failedCount + " 个失败）");
            int r = JOptionPane.showConfirmDialog(frame,
                    "整合包已导入，但有 " + result.failedCount + " 个文件下载失败。\n"
                            + "详见实例目录下的 install-summary.txt。\n\n要仅重试这些失败文件吗？",
                    "部分文件失败", JOptionPane.YES_NO_OPTION, JOptionPane.WARNING_MESSAGE);
            if (r == JOptionPane.YES_OPTION) {
                retryFailedFiles();
            }
            return;
        }
        status("整合包已导入：" + result.instanceName);
        appendLog("整合包已导入：实例 " + result.instanceName + "（" + result.fileCount + " 个文件）");
        JOptionPane.showMessageDialog(frame,
                "整合包已导入。\n\n实例：" + result.instanceName
                        + "\n位置：" + result.instanceDir
                        + "\n\n安装摘要：install-summary.txt"
                        + "\n\n打开 PCL / HMCL 的版本列表即可看到并启动它。",
                "导入完成", JOptionPane.INFORMATION_MESSAGE);
    }

    /** 导入 / 重试被用户取消后的安静收尾：不弹「失败」对话框。 */
    private void finishCancelled() {
        progress.setIndeterminate(false);
        progress.setValue(0);
        progress.setString("");
        packCancel = null;
        installer = null;
        setBusy(false);
        status("已取消");
        appendLog("已取消。");
    }

    private void retryFailedFiles() {
        if (busy || lastPackFile == null) {
            return;
        }
        final Cancel token = new Cancel();
        packCancel = token;
        setBusy(true);
        progress.setIndeterminate(true);
        status("正在重试失败文件…");
        new Thread(() -> {
            try {
                Modpack.Result r = Modpack.retryFailed(lastPackFile, lastPackDir, lastPackName,
                        ((Number) jobsSpinner.getValue()).intValue(), lastPackKey, token, this::appendLog);
                SwingUtilities.invokeLater(() -> {
                    packCancel = null;
                    progress.setIndeterminate(false);
                    setBusy(false);
                    status("重试结束：仍失败 " + r.failedCount + " 个文件");
                    JOptionPane.showMessageDialog(frame,
                            "重试结束。\n\n仍失败：" + r.failedCount + " 个文件"
                                    + "\n详情见实例目录下的 install-summary.txt。",
                            "重试完成", r.failedCount > 0
                                    ? JOptionPane.WARNING_MESSAGE : JOptionPane.INFORMATION_MESSAGE);
                });
            } catch (Throwable t) {
                SwingUtilities.invokeLater(() -> {
                    if (token.isCancelled()) {
                        finishCancelled();
                        return;
                    }
                    packCancel = null;
                    progress.setIndeterminate(false);
                    setBusy(false);
                    status("重试失败：" + t.getMessage());
                    JOptionPane.showMessageDialog(frame, "重试失败：\n" + t.getMessage(),
                            "重试失败", JOptionPane.ERROR_MESSAGE);
                });
            }
        }, "mcdl-retry").start();
    }

    private void openMirrorDialog() {
        javax.swing.JDialog dialog = new javax.swing.JDialog(frame, "镜像源", false);
        dialog.setLayout(new java.awt.BorderLayout(8, 8));
        ((javax.swing.JComponent) dialog.getContentPane()).setBorder(Theme.padding(10, 12, 10, 12));

        String[] cols = {"名称", "地址", "延迟", "成功率", "类型"};
        javax.swing.table.DefaultTableModel model = new javax.swing.table.DefaultTableModel(cols, 0) {
            @Override
            public boolean isCellEditable(int r, int c) {
                return false;
            }

            @Override
            public Class<?> getColumnClass(int c) {
                return switch (c) {
                    case 2 -> Long.class;
                    case 3 -> Double.class;
                    default -> String.class;
                };
            }
        };
        javax.swing.JTable table = new javax.swing.JTable(model);
        table.setAutoCreateRowSorter(true);
        table.setRowHeight(24);
        table.getTableHeader().setReorderingAllowed(false);
        table.getColumnModel().getColumn(0).setPreferredWidth(130);
        table.getColumnModel().getColumn(1).setPreferredWidth(280);
        table.getColumnModel().getColumn(2).setPreferredWidth(70);
        table.getColumnModel().getColumn(3).setPreferredWidth(70);
        table.getColumnModel().getColumn(4).setPreferredWidth(60);
        table.setDefaultRenderer(Long.class, new javax.swing.table.DefaultTableCellRenderer() {
            @Override
            public java.awt.Component getTableCellRendererComponent(javax.swing.JTable t, Object v,
                    boolean sel, boolean focus, int row, int col) {
                Long ms = (Long) v;
                String text;
                java.awt.Color color;
                if (ms == null || ms < 0) {
                    text = "未测速";
                    color = Theme.MUTED;
                } else if (ms == 0) {
                    text = "无法连接";
                    color = new java.awt.Color(0xE74C3C);
                } else {
                    text = ms + " ms";
                    color = Theme.TEXT;
                }
                java.awt.Component c = super.getTableCellRendererComponent(t, text, sel, focus, row, col);
                c.setForeground(sel ? table.getSelectionForeground() : color);
                return c;
            }
        });
        table.setDefaultRenderer(Double.class, new javax.swing.table.DefaultTableCellRenderer() {
            @Override
            public java.awt.Component getTableCellRendererComponent(javax.swing.JTable t, Object v,
                    boolean sel, boolean focus, int row, int col) {
                Double rate = (Double) v;
                String text;
                java.awt.Color color;
                if (rate == null || rate < 0) {
                    text = "未测速";
                    color = Theme.MUTED;
                } else {
                    text = Math.round(rate * 100) + "%";
                    color = rate == 0 ? new java.awt.Color(0xE74C3C) : Theme.TEXT;
                }
                java.awt.Component c = super.getTableCellRendererComponent(t, text, sel, focus, row, col);
                c.setForeground(sel ? table.getSelectionForeground() : color);
                return c;
            }
        });

        Runnable refresh = () -> {
            model.setRowCount(0);
            model.addRow(new Object[]{"官方 Mojang", "https://piston-meta.mojang.com", -1L, -1.0, "内置"});
            model.addRow(new Object[]{"BMCLAPI", Sources.BMCL_ROOT, -1L, -1.0, "内置"});
            for (Sources.CustomMirror m : Sources.customMirrors()) {
                model.addRow(new Object[]{m.name(), m.base(), -1L, -1.0, "自定义"});
            }
        };
        refresh.run();

        javax.swing.JLabel probeStatus = new javax.swing.JLabel("未测速（测速会显示延迟与成功率）");
        probeStatus.setFont(Theme.font(Font.PLAIN, 11));
        probeStatus.setForeground(Theme.MUTED);

        javax.swing.JPanel buttons = new javax.swing.JPanel(new java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 6, 0));
        javax.swing.JButton add = Theme.button("添加");
        javax.swing.JButton del = Theme.button("删除");
        javax.swing.JButton top = Theme.button("置顶");
        javax.swing.JButton probe = Theme.button("测速");
        javax.swing.JButton close = Theme.button("关闭");
        buttons.add(add);
        buttons.add(del);
        buttons.add(top);
        buttons.add(probe);
        buttons.add(close);

        add.addActionListener(e -> {
            javax.swing.JTextField nameField = new javax.swing.JTextField(18);
            javax.swing.JTextField urlField = new javax.swing.JTextField(34);
            javax.swing.JPanel panel = new javax.swing.JPanel(new java.awt.GridLayout(4, 1, 0, 4));
            panel.add(new javax.swing.JLabel("名称（可留空）："));
            panel.add(nameField);
            panel.add(new javax.swing.JLabel("镜像根地址（如 https://bmclapi2.bangbang93.com）："));
            panel.add(urlField);
            int r = javax.swing.JOptionPane.showConfirmDialog(dialog, panel, "添加镜像源",
                    javax.swing.JOptionPane.OK_CANCEL_OPTION, javax.swing.JOptionPane.PLAIN_MESSAGE);
            if (r == javax.swing.JOptionPane.OK_OPTION) {
                try {
                    Sources.addCustomMirror(nameField.getText(), urlField.getText());
                    refresh.run();
                } catch (Exception ex) {
                    javax.swing.JOptionPane.showMessageDialog(dialog, "添加失败：" + ex.getMessage(),
                            "镜像源", javax.swing.JOptionPane.ERROR_MESSAGE);
                }
            }
        });

        del.addActionListener(e -> {
            int row = table.getSelectedRow();
            if (row < 0) {
                return;
            }
            int mRow = table.convertRowIndexToModel(row);
            if (!"自定义".equals(model.getValueAt(mRow, 4))) {
                javax.swing.JOptionPane.showMessageDialog(dialog, "内置镜像不可删除。",
                        "镜像源", javax.swing.JOptionPane.WARNING_MESSAGE);
                return;
            }
            String base = (String) model.getValueAt(mRow, 1);
            java.util.List<Sources.CustomMirror> list = Sources.customMirrors();
            for (int i = 0; i < list.size(); i++) {
                if (list.get(i).base().equals(base)) {
                    Sources.removeCustomMirror(i);
                    break;
                }
            }
            refresh.run();
        });

        top.addActionListener(e -> {
            int row = table.getSelectedRow();
            if (row < 0) {
                return;
            }
            int mRow = table.convertRowIndexToModel(row);
            if (!"自定义".equals(model.getValueAt(mRow, 4))) {
                javax.swing.JOptionPane.showMessageDialog(dialog, "只能置顶自定义镜像。",
                        "镜像源", javax.swing.JOptionPane.WARNING_MESSAGE);
                return;
            }
            String base = (String) model.getValueAt(mRow, 1);
            java.util.List<Sources.CustomMirror> list = Sources.customMirrors();
            for (int i = 0; i < list.size(); i++) {
                if (list.get(i).base().equals(base)) {
                    Sources.moveCustomMirrorTop(i);
                    break;
                }
            }
            refresh.run();
        });

        probe.addActionListener(e -> {
            probe.setEnabled(false);
            probe.setText("测速中…");
            new Thread(() -> {
                java.util.List<Sources.MirrorStatus> statuses = Sources.probeAll();
                SwingUtilities.invokeLater(() -> {
                    StringBuilder summary = new StringBuilder();
                    int okCount = 0;
                    for (Sources.MirrorStatus st : statuses) {
                        for (int r = 0; r < model.getRowCount(); r++) {
                            if (st.base.equals(model.getValueAt(r, 1))) {
                                model.setValueAt(st.latencyMs, r, 2);
                                model.setValueAt(st.successRate, r, 3);
                            }
                        }
                        if (summary.length() > 0) {
                            summary.append("；");
                        }
                        summary.append(st.name).append(' ');
                        if (st.latencyMs > 0) {
                            okCount++;
                            summary.append(st.latencyMs).append(" ms / ")
                                    .append(Math.round(st.successRate * 100)).append('%');
                        } else {
                            summary.append("无法连接");
                        }
                    }
                    if (okCount == 0) {
                        probeStatus.setText("无法连接：所有镜像均不可用");
                    } else {
                        probeStatus.setText("测速完成：" + summary);
                    }
                    probe.setEnabled(true);
                    probe.setText("测速");
                });
            }, "mcdl-mirror-probe").start();
        });

        close.addActionListener(e -> dialog.dispose());

        javax.swing.JPanel south = new javax.swing.JPanel(new java.awt.BorderLayout(0, 6));
        south.setOpaque(false);
        south.add(probeStatus, java.awt.BorderLayout.NORTH);
        south.add(buttons, java.awt.BorderLayout.CENTER);

        dialog.add(new javax.swing.JScrollPane(table), java.awt.BorderLayout.CENTER);
        dialog.add(south, java.awt.BorderLayout.SOUTH);
        dialog.pack();
        dialog.setLocationRelativeTo(frame);
        dialog.setVisible(true);
    }

    private void testCfKey() {
        String key = cfKeyField.getText() == null ? "" : cfKeyField.getText().trim();
        if (key.isEmpty()) {
            JOptionPane.showMessageDialog(frame, "请先填写 CurseForge API key。",
                    "验证 key", JOptionPane.WARNING_MESSAGE);
            return;
        }
        cfTestBtn.setEnabled(false);
        cfTestBtn.setText("验证中…");
        status("正在验证 CurseForge key…");
        new Thread(() -> {
            String result = Modpack.checkKey(key);
            SwingUtilities.invokeLater(() -> {
                cfTestBtn.setEnabled(true);
                cfTestBtn.setText("验证");
                status("CF Key：" + result);
                appendLog("CF Key 验证：" + result);
                if ("有效".equals(result)) {
                    Modpack.saveKey(key);
                }
                JOptionPane.showMessageDialog(frame, "CurseForge key：" + result,
                        "验证结果", "有效".equals(result)
                                ? JOptionPane.INFORMATION_MESSAGE : JOptionPane.WARNING_MESSAGE);
            });
        }, "mcdl-key").start();
    }

    private void openInstanceFolder(Path dir) {
        openInExplorer(dir);
    }

    /**
     * 打开目录：只使用能确认结果的方式。
     *
     * <p>系统 shell（ShellExecute / explorer）在部分机器上会被 HIPS 拦截，且“进程创建成功”
     * 并不代表窗口真的打开。这里先试原生 helper（返回真实 HRESULT），再试 Desktop.open
     * （失败会抛异常）；都失败就打开应用内文件夹窗口，并提示把程序加入安全软件信任区。</p>
     */
    private void openInExplorer(Path dir) {
        if (dir == null) {
            return;
        }
        final Path abs;
        try {
            abs = dir.toAbsolutePath().normalize();
        } catch (RuntimeException e) {
            status("目录不合法：" + dir);
            return;
        }
        if (!Files.isDirectory(abs)) {
            status("目录不存在：" + abs);
            appendLog("打开目录失败（不存在）：" + abs);
            return;
        }
        appendLog("打开目录：" + abs);

        // 1) 原生 helper：SHOpenFolderAndSelectItems / ShellExecuteEx，返回真实 HRESULT
        if (NativeDialog.openWithHelper(abs)) {
            appendLog("打开目录成功（native）：" + abs);
            return;
        }
        String helperError = NativeDialog.lastError();

        // 2) Desktop.open：成功返回，失败抛异常
        String shellError;
        try {
            if (!Desktop.isDesktopSupported()
                    || !Desktop.getDesktop().isSupported(Desktop.Action.OPEN)) {
                shellError = "当前环境不支持 Desktop.open";
            } else {
                Desktop.getDesktop().open(abs.toFile());
                appendLog("打开目录成功（shell）：" + abs);
                return;
            }
        } catch (Exception e) {
            shellError = e.getMessage();
        }

        // 3) 都失败：应用内窗口兜底
        appendLog("打开目录失败：native=" + helperError + "；shell=" + shellError);
        status("系统文件管理器被安全软件拦截，改用应用内窗口");
        Object[] options = {"在应用内查看", "复制路径", "取消"};
        int choice = JOptionPane.showOptionDialog(frame,
                "无法打开系统资源管理器。\n\n"
                        + "通常是安全软件（如火绒 HIPS）拦截了 ShellExecute。\n"
                        + "可以把 MCDL.exe、McdlDialog.exe、java.exe 加入信任区后重试。\n\n"
                        + "目录：\n" + abs,
                "打开目录失败", JOptionPane.DEFAULT_OPTION, JOptionPane.WARNING_MESSAGE,
                null, options, options[0]);
        if (choice == 0) {
            FolderWindow.show(frame, abs);
        } else if (choice == 1) {
            java.awt.Toolkit.getDefaultToolkit().getSystemClipboard()
                    .setContents(new java.awt.datatransfer.StringSelection(abs.toString()), null);
            status("路径已复制到剪贴板");
        }
    }

    private void openGameDir() {
        try {
            openInExplorer(currentDir());
        } catch (RuntimeException e) {
            status("无法打开目录：" + e.getMessage());
        }
    }

    private boolean picking;

    private void chooseDir() {
        if (picking) {
            return;
        }
        picking = true;
        status("正在打开系统文件夹对话框…");
        final Path cur;
        try {
            cur = currentDir();
        } catch (RuntimeException e) {
            picking = false;
            status("安装目录不合法");
            return;
        }
        new Thread(() -> {
            java.io.File picked = null;
            String reason = null;
            try {
                picked = NativeDialog.openFolder(frame, "选择 .minecraft 目录", cur);
                reason = NativeDialog.lastError();
            } catch (RuntimeException | Error e) {
                reason = "系统文件夹对话框异常：" + e.getMessage();
            }
            final java.io.File result = picked;
            final String err = reason;
            SwingUtilities.invokeLater(() -> {
                picking = false;
                if (result != null) {
                    setDirText(result.getAbsolutePath());
                    status("安装目录已更新");
                    refreshTable();
                    updateSelection();
                    return;
                }
                if (err == null) {
                    status("已取消选择");
                    return;
                }
                appendLog("系统文件夹对话框不可用，回退 JFileChooser：" + err);
                chooseDirFallback();
            });
        }, "mcdl-choose-dir").start();
    }

    private void chooseDirFallback() {
        JFileChooser chooser = new JFileChooser();
        chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
        chooser.setDialogTitle("选择 .minecraft 目录");
        try {
            Path cur = currentDir();
            if (Files.isDirectory(cur)) {
                chooser.setCurrentDirectory(cur.toFile());
            }
        } catch (RuntimeException ignored) {
            // 路径非法时忽略
        }
        if (chooser.showOpenDialog(frame) == JFileChooser.APPROVE_OPTION) {
            setDirText(chooser.getSelectedFile().getAbsolutePath());
            refreshTable();
            updateSelection();
        }
    }
    private void installSelected() {
        if (busy) {
            return;
        }
        int row = table.getSelectedRow();
        if (row < 0 || row >= model.size()) {
            status("请先从左侧选择一个版本");
            return;
        }
        final VersionTableModel.Row selected = model.get(row);
        if (selected.localOnly) {
            status("该实例已安装，无需重新下载");
            return;
        }
        final String versionId = selected.id;
        Path dir;
        try {
            dir = currentDir();
        } catch (RuntimeException e) {
            status("安装目录不合法");
            return;
        }
        if (selected.installed) {
            int r = JOptionPane.showConfirmDialog(frame,
                    "目录中已经存在 " + versionId + "，要重新下载并覆盖吗？",
                    "该版本已安装", JOptionPane.YES_NO_OPTION, JOptionPane.QUESTION_MESSAGE);
            if (r != JOptionPane.YES_OPTION) {
                return;
            }
        }

        Installer.Options opt = new Installer.Options();
        opt.dir = dir;
        opt.source = (Sources.Source) sourceBox.getSelectedItem();
        opt.jobs = ((Number) jobsSpinner.getValue()).intValue();
        opt.verify = verifyBox.isSelected();
        opt.assets = assetsBox.isSelected();
        JavaFinder.JavaInfo java = selectedJava();
        opt.javaPath = java == null ? null : java.exe;
        opt.log = this::appendLog;

        final Installer ins = new Installer(opt);
        installer = ins;
        setBusy(true);
        logArea.setText("");
        progress.setValue(0);
        progress.setString("");
        appendLog("开始安装 " + versionId + " 到 " + dir);
        status("正在安装 " + versionId + " …");

        CompletableFuture.runAsync(() -> {
            try {
                Installer.Stats stats = ins.install(versionId);
                SwingUtilities.invokeLater(() -> finishInstall(versionId, stats, null));
            } catch (Throwable t) {
                SwingUtilities.invokeLater(() -> finishInstall(versionId, null, t));
            }
        });
        pollTimer.start();
    }

    private void cancelInstall() {
        Installer ins = installer;
        if (ins != null) {
            ins.cancel();
            status("正在取消安装…");
            return;
        }
        Cancel pack = packCancel;
        if (pack != null) {
            pack.cancel();
            status("正在取消导入…");
        }
    }

    private void finishInstall(String id, Installer.Stats stats, Throwable error) {
        pollTimer.stop();
        setBusy(false);
        installer = null;
        if (error instanceof Cancel.Cancelled) {
            finishCancelled();
            return;
        }
        if (error != null && error.getMessage() != null && error.getMessage().contains("取消")) {
            progress.setValue(0);
            progress.setString("");
            status("已取消安装：" + id);
            appendLog("已取消安装。");
            return;
        }
        if (error == null && stats != null) {
            progress.setValue(1000);
            progress.setString("100%");
            status("安装完成：" + id);
            speedLabel.setText(Installer.human(stats.downloadedBytes()));
            appendLog("安装完成，共下载 " + Installer.human(stats.downloadedBytes())
                    + "，耗时 " + (stats.elapsedMillis() / 1000) + " 秒");
                refreshTable();
            updateSelection();
            JOptionPane.showMessageDialog(frame,
                    "已完成 " + id + " 的下载。\n\n"
                            + "现在打开 PCL2 / HMCL，在版本列表里就能看到并启动它。\n"
                            + "位置：" + dirText(),
                    "安装完成", JOptionPane.INFORMATION_MESSAGE);
        } else {
            status("安装失败：" + (error == null ? "未知错误" : error.getMessage()));
            appendLog("安装失败：" + (error == null ? "未知错误" : error.getMessage()));
            JOptionPane.showMessageDialog(frame,
                    "安装失败：\n" + (error == null ? "未知错误" : error.getMessage()),
                    "安装失败", JOptionPane.ERROR_MESSAGE);
        }
    }

    private void updateProgress() {
        Installer ins = installer;
        if (ins == null) {
            return;
        }
        Installer.Stats s = ins.stats();
        progress.setValue((int) Math.round(s.percent() * 10));
        String text = s.percent() + "%  " + Installer.human(s.doneBytes()) + " / " + Installer.human(s.totalBytes());
        progress.setString(text);
        status(s.phase() + " · 文件 " + s.doneFiles() + "/" + s.totalFiles()
                + (s.skippedFiles() > 0 ? "（已跳过 " + s.skippedFiles() + "）" : "")
                + " · " + s.currentFile());
        speedLabel.setText(String.format(Locale.ROOT, "%s/s  剩余 %s",
                Installer.human((long) s.rate()), s.etaLabel()));
    }

    private void setBusy(boolean value) {
        busy = value;
        installBtn.setEnabled(!value && table.getSelectedRow() >= 0);
        cancelBtn.setEnabled(value);
        refreshBtn.setEnabled(!value);
        browseBtn.setEnabled(!value);
        dirBox.setEnabled(!value);
        detectBtn.setEnabled(!value);
        packBtn.setEnabled(!value);
        openBtn.setEnabled(!value);
        sourceBox.setEnabled(!value);
        jobsSpinner.setEnabled(!value);
        verifyBox.setEnabled(!value);
        assetsBox.setEnabled(!value);
        javaBox.setEnabled(!value);
        scanJavaBtn.setEnabled(!value);
        table.setEnabled(!value);
        frame.setCursor(value ? Cursor.getPredefinedCursor(Cursor.WAIT_CURSOR) : Cursor.getDefaultCursor());
    }

    private void status(String text) {
        statusLabel.setText(text);
        if (statusBarLabel != null) {
            statusBarLabel.setText(text);
        }
    }

    private void appendLog(String text) {
        if (text == null) {
            return;
        }
        SwingUtilities.invokeLater(() -> {
            logArea.append(text + "\n");
            logArea.setCaretPosition(logArea.getDocument().getLength());
        });
    }

    /** 下拉框条目：info == null 表示「自动匹配」。 */
    private static final class JavaChoice {
        final JavaFinder.JavaInfo info;

        JavaChoice(JavaFinder.JavaInfo info) {
            this.info = info;
        }

        @Override
        public String toString() {
            return info == null ? "自动匹配" : info.comboLabel();
        }
    }

    /** 表格渲染：已安装绿色，类型列弱化，奇偶行略有色差。 */
    private static final class RowRenderer extends DefaultTableCellRenderer {
        @Override
        public Component getTableCellRendererComponent(JTable table, Object value, boolean isSelected,
                                                       boolean hasFocus, int row, int column) {
            super.getTableCellRendererComponent(table, value, isSelected, hasFocus, row, column);
            String text = value == null ? "" : value.toString();
            setBorder(BorderFactory.createEmptyBorder(0, 8, 0, 8));
            if (isSelected) {
                setBackground(new Color(0x2F4F86));
                setForeground(Color.WHITE);
                return this;
            }
            setBackground(row % 2 == 0 ? Theme.PANEL : Theme.PANEL_2);
            if (column == 3) {
                setForeground("已安装".equals(text) ? Theme.GREEN : Theme.MUTED);
            } else if (column == 4) {
                setForeground(text.isEmpty() ? Theme.MUTED : Theme.ACCENT);
            } else if (column == 1 || column == 2) {
                setForeground(Theme.MUTED);
            } else {
                setForeground(Theme.TEXT);
            }
            return this;
        }
    }
}
