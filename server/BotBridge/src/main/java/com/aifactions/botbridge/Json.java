package com.aifactions.botbridge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON writer/reader. Supports String, Number, Boolean, Map, List, null.
 * Intentionally tiny — avoids dragging Gson into the plugin classpath.
 */
public final class Json {
    private Json() {}

    // ---------- write ----------

    public static String write(Object v) {
        StringBuilder sb = new StringBuilder();
        append(sb, v);
        return sb.toString();
    }

    private static void append(StringBuilder sb, Object v) {
        if (v == null) { sb.append("null"); return; }
        if (v instanceof Boolean || v instanceof Number) { sb.append(v.toString()); return; }
        if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                appendString(sb, String.valueOf(e.getKey()));
                sb.append(':');
                append(sb, e.getValue());
            }
            sb.append('}');
            return;
        }
        if (v instanceof Iterable) {
            sb.append('[');
            boolean first = true;
            for (Object x : (Iterable<?>) v) {
                if (!first) sb.append(',');
                first = false;
                append(sb, x);
            }
            sb.append(']');
            return;
        }
        appendString(sb, v.toString());
    }

    private static void appendString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                case '\b': sb.append("\\b");  break;
                case '\f': sb.append("\\f");  break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    // ---------- read ----------

    public static Object parse(String s) {
        Parser p = new Parser(s);
        p.skipWs();
        Object v = p.readValue();
        p.skipWs();
        if (p.pos != s.length()) throw new IllegalArgumentException("trailing data at " + p.pos);
        return v;
    }

    public static Map<String, Object> parseObject(String s) {
        Object v = parse(s);
        if (!(v instanceof Map)) throw new IllegalArgumentException("not a JSON object");
        @SuppressWarnings("unchecked")
        Map<String, Object> m = (Map<String, Object>) v;
        return m;
    }

    private static final class Parser {
        final String s; int pos = 0;
        Parser(String s) { this.s = s; }

        void skipWs() {
            while (pos < s.length() && Character.isWhitespace(s.charAt(pos))) pos++;
        }

        Object readValue() {
            skipWs();
            if (pos >= s.length()) throw new IllegalArgumentException("unexpected end");
            char c = s.charAt(pos);
            if (c == '{') return readObject();
            if (c == '[') return readArray();
            if (c == '"') return readString();
            if (c == 't' || c == 'f') return readBool();
            if (c == 'n') { expect("null"); return null; }
            return readNumber();
        }

        Map<String, Object> readObject() {
            expect("{");
            Map<String, Object> m = new LinkedHashMap<>();
            skipWs();
            if (peek() == '}') { pos++; return m; }
            while (true) {
                skipWs();
                String k = readString();
                skipWs();
                expect(":");
                Object v = readValue();
                m.put(k, v);
                skipWs();
                char c = s.charAt(pos++);
                if (c == ',') continue;
                if (c == '}') return m;
                throw new IllegalArgumentException("expected , or } at " + (pos - 1));
            }
        }

        List<Object> readArray() {
            expect("[");
            List<Object> out = new ArrayList<>();
            skipWs();
            if (peek() == ']') { pos++; return out; }
            while (true) {
                out.add(readValue());
                skipWs();
                char c = s.charAt(pos++);
                if (c == ',') continue;
                if (c == ']') return out;
                throw new IllegalArgumentException("expected , or ] at " + (pos - 1));
            }
        }

        String readString() {
            expect("\"");
            StringBuilder sb = new StringBuilder();
            while (pos < s.length()) {
                char c = s.charAt(pos++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    char e = s.charAt(pos++);
                    switch (e) {
                        case '"':  sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/':  sb.append('/'); break;
                        case 'n':  sb.append('\n'); break;
                        case 'r':  sb.append('\r'); break;
                        case 't':  sb.append('\t'); break;
                        case 'b':  sb.append('\b'); break;
                        case 'f':  sb.append('\f'); break;
                        case 'u':
                            int cp = Integer.parseInt(s.substring(pos, pos + 4), 16);
                            sb.append((char) cp);
                            pos += 4;
                            break;
                        default: throw new IllegalArgumentException("bad escape \\" + e);
                    }
                } else {
                    sb.append(c);
                }
            }
            throw new IllegalArgumentException("unterminated string");
        }

        Boolean readBool() {
            if (s.startsWith("true", pos))  { pos += 4; return Boolean.TRUE;  }
            if (s.startsWith("false", pos)) { pos += 5; return Boolean.FALSE; }
            throw new IllegalArgumentException("bad bool at " + pos);
        }

        Number readNumber() {
            int start = pos;
            if (peek() == '-') pos++;
            while (pos < s.length() && "0123456789.eE+-".indexOf(s.charAt(pos)) >= 0) pos++;
            String n = s.substring(start, pos);
            if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
            try { return Long.parseLong(n); } catch (NumberFormatException ex) { return Double.parseDouble(n); }
        }

        char peek() { return pos < s.length() ? s.charAt(pos) : '\0'; }

        void expect(String lit) {
            if (!s.startsWith(lit, pos)) {
                throw new IllegalArgumentException("expected " + lit + " at " + pos);
            }
            pos += lit.length();
        }
    }
}
