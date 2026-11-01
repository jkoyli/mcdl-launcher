package mcdl.ui;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import javax.swing.table.AbstractTableModel;

import mcdl.core.Manifest;

/** 版本列表的表格模型：合并远程版本与本地已安装实例。 */
public final class VersionTableModel extends AbstractTableModel {

    private static final String[] COLUMNS = {"版本", "类型", "发布时间", "状态", "操作"};

    /** 一行：远程版本或本地实例。 */
    public static final class Row {
        public final String id;
        public final String typeLabel;
        public final String date;
        public final boolean installed;
        public final Path dir;
        /** true 表示只存在于 versions 目录（整合包/手动实例），不在官方清单里。 */
        public final boolean localOnly;
        public final Manifest.RemoteVersion remote;

        public Row(String id, String typeLabel, String date, boolean installed, Path dir,
                   boolean localOnly, Manifest.RemoteVersion remote) {
            this.id = id;
            this.typeLabel = typeLabel;
            this.date = date;
            this.installed = installed;
            this.dir = dir;
            this.localOnly = localOnly;
            this.remote = remote;
        }
    }

    private final List<Row> rows = new ArrayList<>();

    public void setRows(List<Row> data) {
        rows.clear();
        rows.addAll(data);
        fireTableDataChanged();
    }

    public Row get(int row) {
        return rows.get(row);
    }

    public int size() {
        return rows.size();
    }

    @Override
    public int getRowCount() {
        return rows.size();
    }

    @Override
    public int getColumnCount() {
        return COLUMNS.length;
    }

    @Override
    public String getColumnName(int column) {
        return COLUMNS[column];
    }

    @Override
    public Class<?> getColumnClass(int columnIndex) {
        return String.class;
    }

    @Override
    public boolean isCellEditable(int rowIndex, int columnIndex) {
        return false;
    }

    @Override
    public Object getValueAt(int rowIndex, int columnIndex) {
        Row row = rows.get(rowIndex);
        return switch (columnIndex) {
            case 0 -> row.id;
            case 1 -> row.typeLabel;
            case 2 -> row.date;
            case 3 -> row.installed ? "已安装" : "";
            case 4 -> row.installed ? "打开文件夹" : "";
            default -> "";
        };
    }
}
