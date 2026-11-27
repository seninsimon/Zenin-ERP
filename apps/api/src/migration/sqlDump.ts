// Bring your data, part 2: read a database dump (.sql) from MySQL / MariaDB
// (mysqldump), Postgres (pg_dump, plain format) or SQL Server ("Generate
// Scripts"). Tables, their columns and types, primary keys, unique columns
// and foreign keys are read exactly; rows come from INSERT and COPY. Stored
// procedures, functions, triggers and views are collected for the migration
// report (part 3): they can't be converted automatically.

export type SqlColumn = { name: string; sqlType: string; notNull: boolean; autoIncrement: boolean; enumValues?: string[] };
export type SqlTable = {
  name: string;
  columns: SqlColumn[];
  primaryKey: string[];
  unique: string[][];
  foreignKeys: { column: string; refTable: string; refColumn: string }[];
  rows: string[][]; // in `columns` order, NULL as ""
};
export type SqlLogic = { kind: "function" | "procedure" | "trigger" | "view"; name: string; sql: string };
export type SqlDump = { tables: SqlTable[]; logic: SqlLogic[] };

type Statement = { text: string; copyData?: string[] };

/* ---------------- splitting into statements ---------------- */

// Split on the statement delimiter, outside quotes, comments and $$ bodies.
// Handles MySQL's DELIMITER, SQL Server's GO, and the data block after COPY.
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let delimiter = ";";
  let buf = "";
  let i = 0;
  const n = sql.length;
  const flush = () => {
    const text = buf.trim();
    buf = "";
    if (!text) return;
    const st: Statement = { text };
    // pg_dump: "COPY t (a, b) FROM stdin;" then rows until a line "\."
    if (/^COPY\s[\s\S]*FROM\s+stdin/i.test(text)) {
      const end = sql.indexOf("\n\\.", i);
      const block = sql.slice(i, end === -1 ? n : end);
      st.copyData = block.replace(/^\r?\n/, "").split(/\r?\n/).filter((l) => l.length);
      i = end === -1 ? n : end + 3;
    }
    out.push(st);
  };
  const atLineStart = () => i === 0 || sql[i - 1] === "\n";
  while (i < n) {
    const c = sql[i];
    // DELIMITER ;; (mysqldump, around triggers and procedures) and GO (SQL Server)
    if (atLineStart()) {
      const line = sql.slice(i, sql.indexOf("\n", i) === -1 ? n : sql.indexOf("\n", i));
      const d = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(line);
      if (d) {
        flush();
        delimiter = d[1];
        i += line.length;
        continue;
      }
      if (/^\s*GO\s*$/i.test(line)) {
        flush();
        i += line.length;
        continue;
      }
    }
    // comments
    if (c === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      i = e === -1 ? n : e;
      continue;
    }
    if (c === "#" && atLineStart()) {
      const e = sql.indexOf("\n", i);
      i = e === -1 ? n : e;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      // MySQL's /*!40101 ... */ hints are kept out too
      i = e === -1 ? n : e + 2;
      buf += " ";
      continue;
    }
    // quoted strings and identifiers
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "\\" && c === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "[") {
      const e = sql.indexOf("]", i);
      buf += sql.slice(i, e === -1 ? n : e + 1);
      i = e === -1 ? n : e + 1;
      continue;
    }
    // Postgres dollar quoting: $$ ... $$ or $body$ ... $body$
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40))?.[0];
      if (tag) {
        const e = sql.indexOf(tag, i + tag.length);
        buf += sql.slice(i, e === -1 ? n : e + tag.length);
        i = e === -1 ? n : e + tag.length;
        continue;
      }
    }
    if (sql.startsWith(delimiter, i)) {
      i += delimiter.length;
      flush();
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/* ---------------- small parsers ---------------- */

// `db`.`orders`, "public"."orders", [dbo].[orders] -> orders
export const ident = (raw: string) => {
  const parts = raw.trim().split(/\.(?=(?:[^"`\]]*["`\[][^"`\]]*["`\]])*[^"`\]]*$)/);
  return parts[parts.length - 1].trim().replace(/^[`"[]|[`"\]]$/g, "");
};

// "a, b(1,2), 'x,y'" -> ["a", "b(1,2)", "'x,y'"] (top-level commas only)
export function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === "'") {
        cur += s[++i] ?? "";
        continue;
      }
      if (c === quote) {
        if (s[i + 1] === quote) {
          cur += s[++i];
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// the text between the parenthesis at `open` and its match
function inParens(s: string, open: number): { inner: string; end: number } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === "'") i++;
      else if (c === quote) quote = s[i + 1] === quote ? (i++, quote) : null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { inner: s.slice(open + 1, i), end: i };
  }
  return { inner: s.slice(open + 1), end: s.length };
}

const columnList = (s: string) => splitTop(s).map(ident);

// a SQL literal as text: 'O''Brien' -> O'Brien, NULL -> "", TRUE -> "true"
export function literal(raw: string): string {
  const v = raw.trim();
  if (/^null$/i.test(v)) return "";
  const q = /^[NnEe]?'([\s\S]*)'$/.exec(v);
  if (q)
    return q[1]
      .replace(/''/g, "'")
      .replace(/\\(.)/g, (_, ch: string) => ({ n: "\n", t: "\t", r: "\r", "0": "" })[ch] ?? ch);
  if (/^(true|false)$/i.test(v)) return v.toLowerCase();
  // casts and calls: '2026-01-01'::date, CAST(x AS ...), now()
  const cast = /^'([^']*)'::/.exec(v);
  if (cast) return cast[1];
  return v;
}

// pg_dump COPY text: tab-separated, \N for NULL, backslash escapes
const copyField = (f: string) =>
  f === "\\N" ? "" : f.replace(/\\(.)/g, (_, ch: string) => ({ n: "\n", t: "\t", r: "\r", "\\": "\\" })[ch] ?? ch);

/* ---------------- the dump ---------------- */

export function readSqlDump(sql: string): SqlDump {
  const tables = new Map<string, SqlTable>();
  const enums = new Map<string, string[]>();
  const logic: SqlLogic[] = [];
  const table = (raw: string) => {
    const name = ident(raw);
    let t = tables.get(name.toLowerCase());
    if (!t) {
      t = { name, columns: [], primaryKey: [], unique: [], foreignKeys: [], rows: [] };
      tables.set(name.toLowerCase(), t);
    }
    return t;
  };
  const addConstraint = (t: SqlTable, def: string) => {
    const d = def.replace(/^CONSTRAINT\s+\S+\s+/i, "");
    let m = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(d);
    if (m) return void (t.primaryKey = columnList(m[1]));
    m = /^UNIQUE(?:\s+(?:KEY|INDEX))?(?:\s+[^\s(]+)?\s*\(([^)]*)\)/i.exec(d);
    if (m) return void t.unique.push(columnList(m[1]));
    m = /^FOREIGN\s+KEY\s*(?:[^\s(]+\s*)?\(([^)]*)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]*)\)/i.exec(d);
    if (m) {
      const cols = columnList(m[1]);
      const refs = columnList(m[3]);
      // a link is one column to one column
      if (cols.length === 1 && refs.length === 1) t.foreignKeys.push({ column: cols[0], refTable: ident(m[2]), refColumn: refs[0] });
    }
  };

  for (const st of splitStatements(sql)) {
    const text = st.text.replace(/^\s+/, "");
    let m: RegExpExecArray | null;

    if ((m = /^CREATE\s+TYPE\s+(\S+)\s+AS\s+ENUM\s*\(/i.exec(text))) {
      enums.set(ident(m[1]).toLowerCase(), splitTop(inParens(text, m[0].length - 1).inner).map(literal));
      continue;
    }
    if ((m = /^CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s*\(/i.exec(text))) {
      const t = table(m[1]);
      for (const def of splitTop(inParens(text, m[0].length - 1).inner)) {
        if (/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY)\b/i.test(def)) {
          addConstraint(t, def);
          continue;
        }
        if (/^(KEY|INDEX|FULLTEXT|SPATIAL|CHECK|EXCLUDE|PERIOD)\b/i.test(def)) continue;
        const cm = /^("[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)\s+([\s\S]*)$/.exec(def);
        if (!cm) continue;
        const name = ident(cm[1]);
        const rest = cm[2];
        const typeMatch = /^([A-Za-z_][\w ]*?(?:\s*\([^)]*\))?(?:\s*\[\])?)(?=\s|$)/.exec(rest);
        const sqlType = (typeMatch?.[1] ?? rest.split(/\s/)[0]).trim();
        const col: SqlColumn = {
          name,
          sqlType,
          notNull: /\bNOT\s+NULL\b/i.test(rest) || /\bPRIMARY\s+KEY\b/i.test(rest),
          autoIncrement: /AUTO_INCREMENT|IDENTITY|^\s*(big|small)?serial/i.test(rest) || /nextval\(/i.test(rest),
        };
        const en = /^enum\s*\(([\s\S]*)\)/i.exec(rest);
        if (en) col.enumValues = splitTop(en[1]).map(literal);
        else if (enums.has(ident(sqlType).toLowerCase())) col.enumValues = enums.get(ident(sqlType).toLowerCase());
        t.columns.push(col);
        if (/\bPRIMARY\s+KEY\b/i.test(rest)) t.primaryKey = [name];
        else if (/\bUNIQUE\b/i.test(rest)) t.unique.push([name]);
        const ref = /\bREFERENCES\s+([^\s(]+)\s*\(([^)]*)\)/i.exec(rest);
        if (ref) t.foreignKeys.push({ column: name, refTable: ident(ref[1]), refColumn: columnList(ref[2])[0] });
      }
      continue;
    }
    if ((m = /^ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([^\s]+)\s+([\s\S]*)$/i.exec(text))) {
      const t = tables.get(ident(m[1]).toLowerCase());
      if (!t) continue;
      for (const part of splitTop(m[2])) {
        const add = /^ADD\s+([\s\S]*)$/i.exec(part.trim());
        if (add) addConstraint(t, add[1].trim());
      }
      continue;
    }
    if ((m = /^INSERT\s+(?:IGNORE\s+)?INTO\s+([^\s(]+)\s*(\([^)]*\))?\s*VALUES\s*/i.exec(text))) {
      const t = table(m[1]);
      const cols = m[2] ? columnList(m[2].slice(1, -1)) : t.columns.map((c) => c.name);
      for (const c of cols) if (!t.columns.some((x) => x.name.toLowerCase() === c.toLowerCase())) t.columns.push({ name: c, sqlType: "", notNull: false, autoIncrement: false });
      const order = t.columns.map((c) => cols.findIndex((x) => x.toLowerCase() === c.name.toLowerCase()));
      let pos = m[0].length;
      while (pos < text.length) {
        const open = text.indexOf("(", pos);
        if (open === -1) break;
        const { inner, end } = inParens(text, open);
        const values = splitTop(inner).map(literal);
        t.rows.push(order.map((k) => (k === -1 ? "" : (values[k] ?? ""))));
        pos = end + 1;
      }
      continue;
    }
    if ((m = /^COPY\s+([^\s(]+)\s*(\([^)]*\))?\s+FROM\s+stdin/i.exec(text))) {
      const t = table(m[1]);
      const cols = m[2] ? columnList(m[2].slice(1, -1)) : t.columns.map((c) => c.name);
      const order = t.columns.map((c) => cols.findIndex((x) => x.toLowerCase() === c.name.toLowerCase()));
      for (const line of st.copyData ?? []) {
        const fields = line.split("\t").map(copyField);
        t.rows.push(order.map((k) => (k === -1 ? "" : (fields[k] ?? ""))));
      }
      continue;
    }
    if ((m = /^CREATE\s+(?:OR\s+REPLACE\s+|OR\s+ALTER\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:MATERIALIZED\s+)?(FUNCTION|PROCEDURE|PROC|TRIGGER|VIEW)\s+([^\s(]+)/i.exec(text))) {
      const kind = m[1].toUpperCase();
      logic.push({
        kind: kind === "PROC" || kind === "PROCEDURE" ? "procedure" : (kind.toLowerCase() as SqlLogic["kind"]),
        name: ident(m[2]),
        sql: text.slice(0, 20_000),
      });
    }
  }
  return { tables: [...tables.values()].filter((t) => t.columns.length), logic };
}
