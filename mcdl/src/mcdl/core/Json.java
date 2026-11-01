package mcdl.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 极简 JSON 实现（解析 + 序列化），不依赖任何第三方库。
 *
 * <p>Minecraft 的版本清单、版本 JSON、资源索引都是 JSON，为了把整个下载器做成
 * 单 jar 零依赖，这里自己实现一份够用的解析器：支持对象、数组、字符串（含
 * Unicode 转义）、数字、布尔、null，以及带 BOM 的 UTF-8 文件。</p>
 */
public final class Json {

    private Json() {
    }

    public enum Kind {OBJECT, ARRAY, STRING, NUMBER, BOOLEAN, NULL}

    /** 解析一段 JSON 文本。 */
    public static Value parse(String text) {
        Parser p = new Parser(text);
        p.skipWs();
        Value v = p.parseValue();
        p.skipWs();
        if (!p.eof()) {
            throw p.error("JSON 末尾存在多余内容");
        }
        return v;
    }

    /** 解析一个 UTF-8 JSON 文件。 */
    public static Value parse(Path file) throws IOException {
        return parse(Files.readString(file, StandardCharsets.UTF_8));
    }

    /** JSON 值。对象用 LinkedHashMap 保存以保留原始字段顺序。 */
    public static final class Value {
        public static final Value NULL = new Value(Kind.NULL, null);
        public static final Value TRUE = new Value(Kind.BOOLEAN, Boolean.TRUE);
        public static final Value FALSE = new Value(Kind.BOOLEAN, Boolean.FALSE);

        private final Kind kind;
        private final Object raw;

        private Value(Kind kind, Object raw) {
            this.kind = kind;
            this.raw = raw;
        }

        public static Value of(String s) {
            return s == null ? NULL : new Value(Kind.STRING, s);
        }

        public static Value of(long n) {
            return new Value(Kind.NUMBER, Long.toString(n));
        }

        public static Value of(double n) {
            return new Value(Kind.NUMBER, Double.toString(n));
        }

        public static Value of(boolean b) {
            return b ? TRUE : FALSE;
        }

        public static Value obj() {
            return new Value(Kind.OBJECT, new LinkedHashMap<String, Value>());
        }

        public static Value arr() {
            return new Value(Kind.ARRAY, new ArrayList<Value>());
        }

        public Kind kind() {
            return kind;
        }

        public boolean isObject() {
            return kind == Kind.OBJECT;
        }

        public boolean isArray() {
            return kind == Kind.ARRAY;
        }

        public boolean isNull() {
            return kind == Kind.NULL;
        }

        public boolean isNumber() {
            return kind == Kind.NUMBER;
        }

        /** 取对象字段；不存在时返回 null。 */
        public Value get(String key) {
            if (kind != Kind.OBJECT) {
                return null;
            }
            return ((Map<String, Value>) raw).get(key);
        }

        /** 取对象字段，不存在时返回 NULL。 */
        public Value opt(String key) {
            Value v = get(key);
            return v == null ? NULL : v;
        }

        /** 按路径逐层取值。 */
        public Value path(String... keys) {
            Value cur = this;
            for (String k : keys) {
                if (cur == null || !cur.isObject()) {
                    return NULL;
                }
                cur = cur.get(k);
            }
            return cur == null ? NULL : cur;
        }

        public boolean has(String key) {
            return kind == Kind.OBJECT && ((Map<String, Value>) raw).containsKey(key);
        }

        public int size() {
            if (kind == Kind.OBJECT) {
                return ((Map<String, Value>) raw).size();
            }
            if (kind == Kind.ARRAY) {
                return ((List<Value>) raw).size();
            }
            return 0;
        }

        public Iterable<Value> values() {
            if (kind == Kind.OBJECT) {
                return ((Map<String, Value>) raw).values();
            }
            if (kind == Kind.ARRAY) {
                return (List<Value>) raw;
            }
            return List.of();
        }

        public Iterable<Map.Entry<String, Value>> entries() {
            if (kind != Kind.OBJECT) {
                return List.of();
            }
            return ((Map<String, Value>) raw).entrySet();
        }

        public List<Value> asList() {
            if (kind == Kind.ARRAY) {
                return (List<Value>) raw;
            }
            return List.of();
        }

        public Map<String, Value> asMap() {
            if (kind == Kind.OBJECT) {
                return (Map<String, Value>) raw;
            }
            return Map.of();
        }

        public String asString() {
            if (kind == Kind.STRING) {
                return (String) raw;
            }
            if (kind == Kind.NULL) {
                return null;
            }
            return toString();
        }

        public String asString(String def) {
            String s = asString();
            return s == null ? def : s;
        }

        public long asLong() {
            return asLong(0L);
        }

        public long asLong(long def) {
            if (kind == Kind.NUMBER) {
                try {
                    return Long.parseLong((String) raw);
                } catch (NumberFormatException e) {
                    return (long) Double.parseDouble((String) raw);
                }
            }
            if (kind == Kind.STRING) {
                try {
                    return Long.parseLong(((String) raw).trim());
                } catch (NumberFormatException e) {
                    return def;
                }
            }
            return def;
        }

        public double asDouble(double def) {
            if (kind == Kind.NUMBER) {
                return Double.parseDouble((String) raw);
            }
            return def;
        }

        public boolean asBoolean(boolean def) {
            if (kind == Kind.BOOLEAN) {
                return (Boolean) raw;
            }
            return def;
        }

        /** 追加数组元素。 */
        public Value add(Value v) {
            if (kind == Kind.ARRAY) {
                ((List<Value>) raw).add(v == null ? NULL : v);
            }
            return this;
        }

        /** 设置对象字段。 */
        public Value put(String key, Value v) {
            if (kind == Kind.OBJECT) {
                ((Map<String, Value>) raw).put(key, v == null ? NULL : v);
            }
            return this;
        }

        public Value put(String key, String s) {
            return put(key, of(s));
        }

        public Value put(String key, long n) {
            return put(key, of(n));
        }

        public Value put(String key, boolean b) {
            return put(key, of(b));
        }

        /** 深拷贝。 */
        public Value copy() {
            return parse(toString());
        }

        @Override
        public String toString() {
            StringBuilder sb = new StringBuilder();
            write(sb, -1, 0);
            return sb.toString();
        }

        public String toPrettyString() {
            StringBuilder sb = new StringBuilder();
            write(sb, 0, 0);
            return sb.toString();
        }

        private void write(StringBuilder sb, int indent, int depth) {
            switch (kind) {
                case NULL -> sb.append("null");
                case BOOLEAN -> sb.append(((Boolean) raw) ? "true" : "false");
                case NUMBER -> sb.append((String) raw);
                case STRING -> escape(sb, (String) raw);
                case ARRAY -> {
                    List<Value> list = (List<Value>) raw;
                    if (list.isEmpty()) {
                        sb.append("[]");
                        return;
                    }
                    sb.append('[');
                    for (int i = 0; i < list.size(); i++) {
                        if (i > 0) {
                            sb.append(',');
                        }
                        newline(sb, indent, depth + 1);
                        list.get(i).write(sb, indent, depth + 1);
                    }
                    newline(sb, indent, depth);
                    sb.append(']');
                }
                case OBJECT -> {
                    Map<String, Value> map = (Map<String, Value>) raw;
                    if (map.isEmpty()) {
                        sb.append("{}");
                        return;
                    }
                    sb.append('{');
                    boolean first = true;
                    for (Map.Entry<String, Value> e : map.entrySet()) {
                        if (!first) {
                            sb.append(',');
                        }
                        first = false;
                        newline(sb, indent, depth + 1);
                        escape(sb, e.getKey());
                        sb.append(':');
                        if (indent >= 0) {
                            sb.append(' ');
                        }
                        e.getValue().write(sb, indent, depth + 1);
                    }
                    newline(sb, indent, depth);
                    sb.append('}');
                }
                default -> sb.append("null");
            }
        }

        private static void newline(StringBuilder sb, int indent, int depth) {
            if (indent >= 0) {
                sb.append('\n');
                sb.append("  ".repeat(depth));
            }
        }

        private static void escape(StringBuilder sb, String s) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"' -> sb.append("\\\"");
                    case '\\' -> sb.append("\\\\");
                    case '\n' -> sb.append("\\n");
                    case '\r' -> sb.append("\\r");
                    case '\t' -> sb.append("\\t");
                    case '\b' -> sb.append("\\b");
                    case '\f' -> sb.append("\\f");
                    default -> {
                        if (c < 0x20) {
                            sb.append(String.format("\\u%04x", (int) c));
                        } else {
                            sb.append(c);
                        }
                    }
                }
            }
            sb.append('"');
        }
    }

    /** 递归下降解析器。 */
    private static final class Parser {
        private final String s;
        private int i;

        Parser(String text) {
            // 去掉 UTF-8 BOM
            if (text != null && !text.isEmpty() && text.charAt(0) == '\uFEFF') {
                text = text.substring(1);
            }
            this.s = text == null ? "" : text;
        }

        boolean eof() {
            return i >= s.length();
        }

        void skipWs() {
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    i++;
                } else {
                    break;
                }
            }
        }

        IllegalArgumentException error(String msg) {
            int line = 1;
            int col = 1;
            for (int k = 0; k < Math.min(i, s.length()); k++) {
                if (s.charAt(k) == '\n') {
                    line++;
                    col = 1;
                } else {
                    col++;
                }
            }
            return new IllegalArgumentException("JSON 解析失败（第 " + line + " 行第 " + col + " 列）：" + msg);
        }

        Value parseValue() {
            skipWs();
            if (eof()) {
                throw error("意外的文件结尾");
            }
            char c = s.charAt(i);
            switch (c) {
                case '{':
                    return parseObject();
                case '[':
                    return parseArray();
                case '"':
                    return Value.of(parseString());
                case 't':
                    expectLiteral("true");
                    return Value.TRUE;
                case 'f':
                    expectLiteral("false");
                    return Value.FALSE;
                case 'n':
                    expectLiteral("null");
                    return Value.NULL;
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) {
                        return parseNumber();
                    }
                    throw error("非法字符 '" + c + "'");
            }
        }

        void expectLiteral(String lit) {
            if (!s.startsWith(lit, i)) {
                throw error("期望 " + lit);
            }
            i += lit.length();
        }

        Value parseObject() {
            Value v = Value.obj();
            i++; // {
            skipWs();
            if (!eof() && s.charAt(i) == '}') {
                i++;
                return v;
            }
            while (true) {
                skipWs();
                if (eof() || s.charAt(i) != '"') {
                    throw error("对象的键必须是字符串");
                }
                String key = parseString();
                skipWs();
                if (eof() || s.charAt(i) != ':') {
                    throw error("缺少 ':'");
                }
                i++;
                v.put(key, parseValue());
                skipWs();
                if (eof()) {
                    throw error("对象未闭合");
                }
                char c = s.charAt(i);
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == '}') {
                    i++;
                    return v;
                }
                throw error("对象中缺少 ',' 或 '}'");
            }
        }

        Value parseArray() {
            Value v = Value.arr();
            i++; // [
            skipWs();
            if (!eof() && s.charAt(i) == ']') {
                i++;
                return v;
            }
            while (true) {
                v.add(parseValue());
                skipWs();
                if (eof()) {
                    throw error("数组未闭合");
                }
                char c = s.charAt(i);
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == ']') {
                    i++;
                    return v;
                }
                throw error("数组中缺少 ',' 或 ']'");
            }
        }

        String parseString() {
            i++; // "
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (eof()) {
                    throw error("字符串未闭合");
                }
                char c = s.charAt(i++);
                if (c == '"') {
                    return sb.toString();
                }
                if (c == '\\') {
                    if (eof()) {
                        throw error("转义序列不完整");
                    }
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"' -> sb.append('"');
                        case '\\' -> sb.append('\\');
                        case '/' -> sb.append('/');
                        case 'b' -> sb.append('\b');
                        case 'f' -> sb.append('\f');
                        case 'n' -> sb.append('\n');
                        case 'r' -> sb.append('\r');
                        case 't' -> sb.append('\t');
                        case 'u' -> {
                            if (i + 4 > s.length()) {
                                throw error("\\u 转义不完整");
                            }
                            String hex = s.substring(i, i + 4);
                            try {
                                sb.append((char) Integer.parseInt(hex, 16));
                            } catch (NumberFormatException ex) {
                                throw error("非法的 \\u 转义：" + hex);
                            }
                            i += 4;
                        }
                        default -> throw error("未知转义 \\" + e);
                    }
                } else {
                    sb.append(c);
                }
            }
        }

        Value parseNumber() {
            int start = i;
            if (!eof() && s.charAt(i) == '-') {
                i++;
            }
            while (!eof()) {
                char c = s.charAt(i);
                if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                    i++;
                } else {
                    break;
                }
            }
            String num = s.substring(start, i);
            try {
                Double.parseDouble(num);
            } catch (NumberFormatException e) {
                throw error("非法数字 " + num);
            }
            return new Value(Kind.NUMBER, num);
        }
    }
}
