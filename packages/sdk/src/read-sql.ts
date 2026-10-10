import { FlaredError } from "./protocol.js";
/** Restricted SELECT capability, not a general SQL parser. Drizzle's select/count
 * emit one SELECT. Explicit CTE/PRAGMA/raw multi-statement access is not exposed. */
export function assertReadSql(sql: string): void {
  let i = 0,
    first = "";
  while (i < sql.length) {
    const c = sql[i],
      next = sql[i + 1];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0)
        throw new FlaredError("READ_ONLY", "Unterminated SQL comment");
      i = end + 2;
      continue;
    }
    if (!first) {
      const word = /^[A-Za-z]+/.exec(sql.slice(i))?.[0];
      if (!word || word.toLowerCase() !== "select")
        throw new FlaredError(
          "READ_ONLY",
          "Only SELECT statements are available in query/live",
        );
      first = word;
      i += word.length;
      continue;
    }
    if (c === ";")
      throw new FlaredError(
        "READ_ONLY",
        "Multiple SQL statements are unavailable in query/live",
      );
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (c !== "[" && sql[i + 1] === close) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed)
        throw new FlaredError("READ_ONLY", "Unterminated SQL literal");
      continue;
    }
    i++;
  }
  if (!first) throw new FlaredError("READ_ONLY", "Expected SELECT statement");
}
