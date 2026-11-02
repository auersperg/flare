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
export interface SearchContext {
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
