import { FlareError, type Json } from "./protocol.js";

export type SearchState = {
  fileId: string;
  enabled: boolean;
  status:
    | "excluded"
    | "pending"
    | "sending"
    | "queued"
    | "running"
    | "completed"
    | "error"
    | "skipped"
    | "outdated"
    | "deleting";
  error: string | null;
};
export type SearchHit = {
  fileId: string;
  name: string;
  text: string;
  score: number;
};
export type SearchRecord = {
  /** Stable source UUID and monotonically increasing source revision. */
  id: string;
  version: number;
  /** Server-selected access partition; never accept an unchecked client owner. */
  partition: string;
  /** null excludes the record; retain a source tombstone for delayed jobs. */
  text: string | null;
  metadata?: Record<string, string>;
};
export type SearchRecordRef = Pick<SearchRecord, "id" | "version">;
export type SearchRecordState = SearchRecordRef & Omit<SearchState, "fileId">;
export type SearchRecordHit = SearchRecordRef & { text: string; score: number };
export interface SearchRecords {
  /** Schedule from a source mutation's transactional outbox; re-read source in the job. */
  sync(input: SearchRecord): Promise<SearchRecordState>;
  status(input: { id: string; partition: string }): Promise<SearchRecordState>;
  query(
    input: { query: string; partition: string; limit?: number },
    authorize: (records: SearchRecordRef[]) => Promise<SearchRecordRef[]>,
  ): Promise<SearchRecordHit[]>;
}
export interface SearchContext {
  readonly records: SearchRecords;
  index(fileId: string): Promise<SearchState>;
  exclude(fileId: string): Promise<SearchState>;
  status(fileId: string): Promise<SearchState>;
  query(
    input: { query: string; limit?: number; fileIds?: string[] },
    authorize: (fileIds: string[]) => Promise<string[]>,
  ): Promise<SearchHit[]>;
}

/** Runs in the trusted action, never in browser code. ACLs remain application data. */
export function searchContext(
  command: (op: string, input: Json) => Promise<any>,
): SearchContext {
  return {
    records: {
      sync: (input) => command("record-sync", input),
      status: (input) => command("record-status", input),
      async query(input, authorize) {
        if (typeof authorize !== "function")
          throw new FlareError(
            "FORBIDDEN",
            "A current source access/version check is required",
          );
        const hits: SearchRecordHit[] = await command("record-query", input);
        if (!hits.length) return [];
        const allowed = await authorize(
          hits.map(({ id, version }) => ({ id, version })),
        );
        if (
          !Array.isArray(allowed) ||
          allowed.some(
            (a) => !hits.some((h) => h.id === a.id && h.version === a.version),
          )
        )
          throw new FlareError("FORBIDDEN", "Invalid source access result");
        const current: SearchRecordRef[] = await command("record-validate", {
          partition: input.partition,
          records: allowed,
        });
        return hits.filter((h) =>
          current.some((a) => a.id === h.id && a.version === h.version),
        );
      },
    },
    index: (fileId) => command("index", { fileId }),
    exclude: (fileId) => command("exclude", { fileId }),
    status: (fileId) => command("status", { fileId }),
    async query(input, authorize) {
      if (typeof authorize !== "function")
        throw new FlareError(
          "FORBIDDEN",
          "A current file access check is required",
        );
      const hits: SearchHit[] = await command("query", input);
      if (!hits.length) return [];
      const ids = [...new Set(hits.map((h) => h.fileId))];
      const allowed = await authorize(ids);
      if (!Array.isArray(allowed) || allowed.some((id) => !ids.includes(id)))
        throw new FlareError("FORBIDDEN", "Invalid file access result");
      // Recheck current inclusion/original state after the application's ACL query.
      const current: string[] = await command("validate", { fileIds: allowed });
      const visible = new Set(current);
      return hits.filter((h) => visible.has(h.fileId));
    },
  };
}
