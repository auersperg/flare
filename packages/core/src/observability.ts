import { status } from "./security.js";
type Summary = {
  at: number;
  path: string;
  kind: string;
  status: string;
  ms: number;
};
/** Bounded summaries, not a second logs/metrics platform. Successful reads stay
 * ephemeral, so diagnostics cannot turn them into supervisor SQL writes. */
export class InvocationSummaries {
  private queries: Summary[] = [];
  constructor(private sql: SqlStorage) {}
  record(entry: Summary) {
    if (entry.kind === "query" && entry.status === "ok") {
      this.queries.push(entry);
      if (this.queries.length > 100) this.queries.shift();
      return;
    }
    try {
      this.sql.exec(
        "INSERT INTO events (at,path,kind,status,ms) VALUES (?,?,?,?,?)",
        entry.at,
        entry.path,
        entry.kind,
        entry.status,
        entry.ms,
      );
      this.sql.exec(
        "DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id),0)-200 FROM events)",
      );
    } catch (error) {
      console.warn({
        source: "flare-observability",
        path: entry.path,
        kind: entry.kind,
        code: status(error).code,
      });
    }
  }
  list() {
    return [
      ...this.queries,
      ...this.sql
        .exec(
          "SELECT at,path,kind,status,ms FROM events ORDER BY id DESC LIMIT 100",
        )
        .toArray(),
    ]
      .sort((a, b) => Number(b.at) - Number(a.at))
      .slice(0, 100);
  }
}
