import {
  boundedJson,
  LIMITS,
  errorCode,
  stableJson,
} from "../../flare/src/sdk/protocol.js";
import type {
  SearchHit,
  SearchState,
  SearchRecord,
  SearchRecordRef,
  SearchRecordState,
  SearchRecordHit,
} from "../../flare/src/sdk/search.js";
import { appPolicy, type PolicyEnv } from "./capabilities.js";
import { fileKey } from "./files.js";
import { fail } from "./security.js";

type Row = {
  id: string;
  key: string;
  version: string;
  binding: string;
  item: string | null;
  status: string;
  wanted: number;
  attempts: number;
  uncertain: number;
  error: string | null;
  record_id: string | null;
  partition: string | null;
  text: string | null;
  metadata: string | null;
};
type SearchEnv = PolicyEnv & { FILES?: R2Bucket };
const states = new Set([
  "queued",
  "running",
  "completed",
  "error",
  "skipped",
  "outdated",
]);

/** Derived-data checkpoints in the existing environment supervisor, not application ACLs. */
export class SearchStore {
  private working?: Promise<void>;
  constructor(
    private storage: DurableObjectStorage,
    private env: SearchEnv,
    private scope: string,
    private wake: () => Promise<unknown>,
  ) {}
  static initialize(storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS search_items (id TEXT PRIMARY KEY,key TEXT NOT NULL,version TEXT NOT NULL,binding TEXT NOT NULL,item TEXT,status TEXT NOT NULL,wanted INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,uncertain INTEGER NOT NULL DEFAULT 0,error TEXT)",
    );
    const columns = new Set(
      storage.sql
        .exec("PRAGMA table_info(search_items)")
        .toArray()
        .map((r) => r.name),
    );
    for (const name of ["record_id", "partition", "text", "metadata"])
      if (!columns.has(name))
        storage.sql.exec(`ALTER TABLE search_items ADD COLUMN ${name} TEXT`);
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS search_records (id TEXT NOT NULL,partition TEXT NOT NULL,version INTEGER NOT NULL,digest TEXT NOT NULL,wanted INTEGER NOT NULL,current TEXT,PRIMARY KEY(id,partition))",
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS search_record_versions ON search_items(record_id,partition)",
    );
  }
  private head(id: string, partition: string) {
    this.recordRef(id, partition);
    return this.storage.sql
      .exec<{
        id: string;
        partition: string;
        version: number;
        digest: string;
        wanted: number;
        current: string | null;
      }>(
        "SELECT * FROM search_records WHERE id=? AND partition=?",
        id,
        partition,
      )
      .toArray()[0];
  }
  private recordRef(id: string, partition: string) {
    fileKey(this.scope, id);
    if (
      typeof partition !== "string" ||
      !partition ||
      new TextEncoder().encode(partition).length > 128
    )
      fail("INVALID_INPUT");
  }
  private async hash(value: string) {
    return Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  private async folder(partition: string) {
    return (
      (await this.hash(JSON.stringify([this.scope, partition]))).slice(0, 32) +
      "/"
    );
  }
  private row(id: string): Row | undefined {
    fileKey(this.scope, id);
    return this.storage.sql
      .exec("SELECT * FROM search_items WHERE id=?", id)
      .toArray()[0] as Row | undefined;
  }
  private original(id: string) {
    const row = this.row(id);
    if (row?.record_id) {
      const head = this.head(row.record_id, row.partition!);
      return head?.wanted && head.current === id
        ? { name: row.record_id, type: "text/plain" }
        : undefined;
    }
    return this.storage.sql
      .exec("SELECT name,type FROM files WHERE id=? AND state='ready'", id)
      .toArray()[0];
  }
  private binding(name = appPolicy(this.env, this.scope).search) {
    if (!name) fail("SEARCH_NOT_CONFIGURED");
    const binding = (this.env as Record<string, unknown>)[name] as
      AiSearchInstance | undefined;
    if (!binding?.items || typeof binding.search !== "function")
      fail("SEARCH_UNAVAILABLE");
    return binding;
  }
  private state(id: string): SearchState {
    const row = this.row(id);
    return {
      fileId: id,
      enabled: row?.wanted === 1,
      status: row
        ? ((row.wanted ? row.status : "deleting") as SearchState["status"])
        : "excluded",
      error: row?.error ?? null,
    };
  }
  async reconcile() {
    this.storage.sql.exec(
      "UPDATE search_items SET wanted=0,attempts=0,error=NULL,text=NULL,metadata=NULL WHERE binding!=? AND wanted=1",
      appPolicy(this.env, this.scope).search ?? "",
    );
    // A reset on the final attempt must not leave a permanently "sending" item without an error.
    this.storage.sql.exec(
      "UPDATE search_items SET status='error',error=COALESCE(error,'SEARCH_RECONCILE_REQUIRED') WHERE (wanted=0 OR status IN ('pending','sending')) AND attempts>=3",
    );
    if (
      this.storage.sql
        .exec(
          "SELECT 1 FROM search_items WHERE (wanted=0 OR status IN ('pending','sending')) AND attempts<3 LIMIT 1",
        )
        .toArray().length
    )
      await this.wake();
  }
  summary() {
    return {
      binding: appPolicy(this.env, this.scope).search ?? null,
      remaining: Number(
        this.storage.sql.exec("SELECT COUNT(*) n FROM search_items").one().n,
      ),
      states: this.storage.sql
        .exec(
          "SELECT CASE WHEN wanted=0 THEN 'deleting' ELSE status END status,COUNT(*) count FROM search_items GROUP BY 1",
        )
        .toArray(),
      errors: Number(
        this.storage.sql
          .exec("SELECT COUNT(*) n FROM search_items WHERE error IS NOT NULL")
          .one().n,
      ),
    };
  }
  async index(id: string) {
    const binding = appPolicy(this.env, this.scope).search;
    this.binding(binding);
    fileKey(this.scope, id);
    const file = this.original(id);
    if (!file) fail("NOT_FOUND");
    const extension =
      file.type === "application/pdf"
        ? "pdf"
        : file.type === "text/plain"
          ? "txt"
          : fail("UNSUPPORTED");
    const row = this.row(id);
    if (row) {
      if (!row.wanted || row.binding !== binding) fail("SEARCH_BUSY");
      if (
        ["error", "skipped", "outdated"].includes(row.status) ||
        (row.attempts >= 3 && ["pending", "sending"].includes(row.status))
      ) {
        this.storage.sql.exec(
          "UPDATE search_items SET status='pending',attempts=0,error=NULL WHERE id=?",
          id,
        );
      }
      if (["pending", "sending"].includes(this.row(id)!.status))
        await this.wake();
      return this.state(id);
    }
    // File IDs are immutable. Record intent before the first await so exclude/clear can fence it.
    // Capture the actual R2 version in recovery before sending bytes, not on the request path.
    const key = `${id}/source.${extension}`;
    this.storage.sql.exec(
      "INSERT INTO search_items (id,key,version,binding,status,wanted) VALUES (?,?,'',?,'pending',1)",
      id,
      key,
      binding!,
    );
    await this.wake(); // Success is reported only after the durable wake is armed.
    return this.state(id);
  }
  async exclude(id: string) {
    if (this.row(id)) {
      // Close the read path synchronously; durable retry is armed before destructive I/O.
      this.storage.sql.exec(
        "UPDATE search_items SET wanted=0,attempts=0,error=NULL WHERE id=?",
        id,
      );
      await this.wake();
    }
    return this.state(id);
  }
  async clear() {
    this.storage.sql.exec("UPDATE search_records SET wanted=0");
    this.storage.sql.exec(
      "UPDATE search_items SET wanted=0,attempts=0,error=NULL,text=NULL,metadata=NULL",
    );
    await this.wake();
    return this.summary();
  }
  async status(id: string) {
    const row = this.row(id);
    if (row?.wanted && row.item && states.has(row.status)) {
      try {
        const info = await this.binding(row.binding).items.get(row.item).info();
        const current = this.row(id);
        if (
          current?.wanted === 1 &&
          current.item === row.item &&
          current.status === row.status &&
          current.attempts === row.attempts
        )
          this.updateInfo(row, info);
      } catch {
        fail("SEARCH_UNAVAILABLE");
      }
    }
    return this.state(id);
  }
  private updateInfo(row: Row, info: AiSearchItemInfo) {
    if (info.key !== row.key || !states.has(info.status))
      fail("SEARCH_UNAVAILABLE");
    if (
      row.record_id &&
      ["queued", "running", "completed"].includes(info.status)
    )
      this.storage.sql.exec(
        "UPDATE search_items SET text=NULL WHERE id=?",
        row.id,
      );
    this.storage.sql.exec(
      "UPDATE search_items SET item=?,status=?,error=?,uncertain=0 WHERE id=? AND key=? AND wanted=1",
      info.id,
      info.status,
      info.status === "error" ? "INDEXING_FAILED" : null,
      row.id,
      row.key,
    );
    // Preserve the ID even if exclusion happened during upload. Cleanup owns the row now.
    this.storage.sql.exec(
      "UPDATE search_items SET item=?,uncertain=0 WHERE id=? AND key=? AND wanted=0",
      info.id,
      row.id,
      row.key,
    );
  }
  validate(ids: string[]) {
    if (!Array.isArray(ids) || ids.length > 20) fail("INVALID_INPUT");
    for (const id of ids) fileKey(this.scope, id);
    const binding = appPolicy(this.env, this.scope).search;
    if (!ids.length || !binding) return [];
    return this.storage.sql
      .exec(
        `SELECT s.id FROM search_items s JOIN files f ON f.id=s.id WHERE s.wanted=1 AND s.binding=? AND s.status IN ('queued','running','completed') AND f.state='ready' AND s.id IN (${ids.map(() => "?").join(",")})`,
        binding,
        ...ids,
      )
      .toArray()
      .map((row) => String(row.id));
  }
  async query(input: {
    query: string;
    limit?: number;
    fileIds?: string[];
  }): Promise<SearchHit[]> {
    if (
      !input ||
      typeof input.query !== "string" ||
      !input.query.trim() ||
      input.query.length > 2000 ||
      Object.keys(input).some((k) => !["query", "limit", "fileIds"].includes(k))
    )
      fail("INVALID_INPUT");
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      fail("INVALID_INPUT");
    const binding = appPolicy(this.env, this.scope).search;
    const instance = this.binding(binding);
    let selected: Set<string> | undefined;
    if (input.fileIds !== undefined) {
      if (!Array.isArray(input.fileIds) || input.fileIds.length > 20)
        fail("INVALID_INPUT");
      selected = new Set(this.validate(input.fileIds));
      if (!selected.size) return [];
    }
    let result: AiSearchSearchResponse;
    try {
      result = await instance.search({
        query: input.query,
        ai_search_options: {
          retrieval: {
            max_num_results: limit,
            return_on_failure: false,
            ...(selected
              ? {
                  filters: {
                    folder: { $in: [...selected].map((id) => id + "/") },
                  },
                }
              : {}),
          },
          query_rewrite: { enabled: false },
          reranking: { enabled: false },
          cache: { enabled: false },
        },
      });
    } catch {
      fail("SEARCH_UNAVAILABLE");
    }
    const chunks = result.chunks.slice(0, limit);
    if (!chunks.length) return [];
    const keys = [...new Set(chunks.map((chunk) => chunk.item.key))];
    const visible = new Map(
      this.storage.sql
        .exec(
          `SELECT s.id,s.key,f.name FROM search_items s JOIN files f ON f.id=s.id WHERE s.wanted=1 AND s.binding=? AND s.status IN ('queued','running','completed') AND f.state='ready' AND s.key IN (${keys.map(() => "?").join(",")})`,
          binding!,
          ...keys,
        )
        .toArray()
        .map((row) => [String(row.key), row]),
    );
    const hits: SearchHit[] = [];
    for (const chunk of chunks) {
      const row = visible.get(chunk.item.key);
      if (!row || (selected && !selected.has(String(row.id)))) continue;
      if (typeof chunk.text !== "string" || !Number.isFinite(chunk.score))
        fail("SEARCH_UNAVAILABLE");
      hits.push({
        fileId: String(row.id),
        name: String(row.name),
        text: chunk.text.slice(0, 2000),
        score: chunk.score,
      });
    }
    boundedJson(hits, LIMITS.outputBytes);
    return hits;
  }
  async syncRecord(input: SearchRecord): Promise<SearchRecordState> {
    boundedJson(input, 20000);
    if (
      !input ||
      Object.keys(input).some(
        (k) => !["id", "partition", "version", "text", "metadata"].includes(k),
      )
    )
      fail("INVALID_INPUT");
    this.recordRef(input.id, input.partition);
    if (
      !Number.isSafeInteger(input.version) ||
      input.version < 1 ||
      (input.text !== null &&
        (typeof input.text !== "string" ||
          !input.text.trim() ||
          new TextEncoder().encode(input.text).length > 16384))
    )
      fail("INVALID_INPUT");
    const metadata = input.metadata ?? {};
    if (
      !metadata ||
      Array.isArray(metadata) ||
      typeof metadata !== "object" ||
      Object.keys(metadata).length > 5 ||
      Object.entries(metadata).some(
        ([k, v]) =>
          !/^[a-z][a-z0-9_]{0,31}$/.test(k) ||
          ["folder", "filename", "timestamp"].includes(k) ||
          typeof v !== "string" ||
          new TextEncoder().encode(v).length > 64,
      )
    )
      fail("INVALID_INPUT");
    const digest = await this.hash(stableJson({ text: input.text, metadata }));
    const folder = await this.folder(input.partition);
    const head = this.head(input.id, input.partition);
    const binding = appPolicy(this.env, this.scope).search;
    if (head && input.version < head.version) return this.recordState(input);
    if (
      head &&
      input.version === head.version &&
      (digest !== head.digest || Boolean(head.wanted) !== (input.text !== null))
    )
      fail("CONFLICT");
    const current = head?.current ? this.row(head.current) : undefined;
    if (input.text !== null) this.binding(binding);
    if (
      head?.version === input.version &&
      (input.text === null || (current?.wanted && current.binding === binding))
    ) {
      if (current && ["error", "skipped", "outdated"].includes(current.status))
        this.storage.sql.exec(
          "UPDATE search_items SET status='pending',attempts=0,error=NULL,text=? WHERE id=?",
          input.text,
          current.id,
        );
      await this.wake();
      return this.recordState(input);
    }
    // No await between fencing old versions and installing the new head.
    this.storage.sql.exec(
      "UPDATE search_items SET wanted=0,text=NULL,metadata=NULL,attempts=0,error=NULL WHERE record_id=? AND partition=?",
      input.id,
      input.partition,
    );
    const id = input.text === null ? null : crypto.randomUUID();
    if (id)
      this.storage.sql.exec(
        "INSERT INTO search_items (id,key,version,binding,status,wanted,record_id,partition,text,metadata) VALUES (?,?,?,?,'pending',1,?,?,?,?)",
        id,
        folder + id + ".txt",
        String(input.version),
        binding!,
        input.id,
        input.partition,
        input.text,
        Object.keys(metadata).length ? JSON.stringify(metadata) : null,
      );
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO search_records VALUES (?,?,?,?,?,?)",
      input.id,
      input.partition,
      input.version,
      digest,
      Number(input.text !== null),
      id,
    );
    await this.wake();
    return this.recordState(input);
  }
  private recordState(input: {
    id: string;
    partition: string;
  }): SearchRecordState {
    const head = this.head(input.id, input.partition);
    const row = head?.current ? this.row(head.current) : undefined;
    const pending = this.storage.sql
      .exec(
        "SELECT error FROM search_items WHERE record_id=? AND partition=? AND wanted=0",
        input.id,
        input.partition,
      )
      .toArray();
    return {
      id: input.id,
      version: head?.version ?? 0,
      enabled: Boolean(
        head?.wanted &&
        row?.wanted &&
        row.binding === appPolicy(this.env, this.scope).search,
      ),
      status:
        head?.wanted && row?.wanted
          ? (row.status as SearchState["status"])
          : pending.length
            ? "deleting"
            : "excluded",
      error:
        row?.error ??
        (pending.find((r) => r.error)?.error as string | undefined) ??
        null,
    };
  }
  async recordStatus(input: { id: string; partition: string }) {
    const head = this.head(input.id, input.partition);
    if (head?.current) await this.status(head.current);
    return this.recordState(input);
  }
  validateRecords(input: { partition: string; records: SearchRecordRef[] }) {
    if (!Array.isArray(input?.records) || input.records.length > 20)
      fail("INVALID_INPUT");
    return input.records.filter(({ id, version }) => {
      const head = this.head(id, input.partition);
      const row = head?.current ? this.row(head.current) : undefined;
      return (
        head?.wanted &&
        head.version === version &&
        row?.wanted &&
        row.binding === appPolicy(this.env, this.scope).search
      );
    });
  }
  async queryRecords(input: {
    query: string;
    partition: string;
    limit?: number;
  }): Promise<SearchRecordHit[]> {
    boundedJson(input, 10000);
    if (
      !input ||
      typeof input.query !== "string" ||
      !input.query.trim() ||
      input.query.length > 2000 ||
      Object.keys(input).some(
        (k) => !["query", "partition", "limit"].includes(k),
      )
    )
      fail("INVALID_INPUT");
    this.recordRef("00000000-0000-4000-8000-000000000000", input.partition);
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      fail("INVALID_INPUT");
    const binding = appPolicy(this.env, this.scope).search;
    const instance = this.binding(binding);
    const folder = await this.folder(input.partition);
    let result: AiSearchSearchResponse;
    try {
      result = await instance.search({
        query: input.query,
        ai_search_options: {
          retrieval: {
            max_num_results: limit,
            return_on_failure: false,
            filters: { folder },
          },
          query_rewrite: { enabled: false },
          reranking: { enabled: false },
          cache: { enabled: false },
        },
      });
    } catch {
      fail("SEARCH_UNAVAILABLE");
    }
    const hits: SearchRecordHit[] = [];
    for (const chunk of result.chunks.slice(0, limit)) {
      const row = this.storage.sql
        .exec(
          "SELECT s.record_id,h.version FROM search_items s JOIN search_records h ON h.current=s.id WHERE s.key=? AND s.binding=? AND s.partition=? AND s.wanted=1 AND h.wanted=1",
          chunk.item.key,
          binding!,
          input.partition,
        )
        .toArray()[0];
      if (!row) continue;
      if (typeof chunk.text !== "string" || !Number.isFinite(chunk.score))
        fail("SEARCH_UNAVAILABLE");
      hits.push({
        id: String(row.record_id),
        version: Number(row.version),
        text: chunk.text.slice(0, 2000),
        score: chunk.score,
      });
    }
    return hits;
  }
  /** One bounded native recovery batch; never holds the supervisor's application gate. */
  work() {
    return (this.working ??= this.process().finally(() => {
      this.working = undefined;
    }));
  }
  private async process() {
    const rows = this.storage.sql
      .exec(
        "SELECT * FROM search_items WHERE (wanted=0 OR status IN ('pending','sending')) AND attempts<3 LIMIT 5",
      )
      .toArray() as Row[];
    for (const row of rows) {
      this.storage.sql.exec(
        "UPDATE search_items SET attempts=attempts+1 WHERE id=?",
        row.id,
      );
      try {
        const instance = this.binding(row.binding);
        const existing = (
          await instance.items.list({
            key: row.key,
            source: "builtin",
            per_page: 50,
          })
        ).result.filter(
          (item) => item.key === row.key && item.source_id === "builtin",
        );
        // Re-read after provider I/O: exclusion/source deletion always wins.
        const current = this.row(row.id);
        if (!current) continue;
        if (
          !current.wanted ||
          !this.original(row.id) ||
          appPolicy(this.env, this.scope).search !== row.binding
        ) {
          this.storage.sql.exec(
            "UPDATE search_items SET wanted=0 WHERE id=?",
            row.id,
          );
          // A missing list result cannot prove that an uncertain upload will never commit.
          if (current.uncertain && !existing.length)
            fail("SEARCH_RECONCILE_REQUIRED");
          if (existing.length)
            this.storage.sql.exec(
              "UPDATE search_items SET uncertain=0 WHERE id=?",
              row.id,
            );
          // An empty list is not a deletion acknowledgement for an item whose ID we know.
          const ids = new Set(existing.map((item) => item.id));
          if (current.item) ids.add(current.item);
          for (const id of ids) {
            try {
              await instance.items.delete(id);
            } catch (error) {
              // The native binding may expose a plain Error; only its exact item-not-found code proves absence.
              if (
                !(error instanceof Error) ||
                error.message !== "item_not_found"
              )
                throw error;
            }
          }
          this.storage.sql.exec("DELETE FROM search_items WHERE id=?", row.id);
          continue;
        }
        if (
          existing[0] &&
          !["error", "skipped", "outdated"].includes(existing[0].status)
        ) {
          this.updateInfo(row, existing[0]);
        } else {
          const object = row.record_id
            ? null
            : await this.env.FILES?.get(fileKey(this.scope, row.id));
          const content = row.record_id ? this.row(row.id)?.text : object?.body;
          if (content == null) fail("NOT_FOUND");
          if (object && row.version && object.version !== row.version) {
            await object.body.cancel();
            fail("NOT_FOUND");
          }
          if (!this.row(row.id)?.wanted || !this.original(row.id)) {
            await object?.body.cancel();
            continue;
          }
          this.storage.sql.exec(
            "UPDATE search_items SET status='sending',uncertain=1,version=? WHERE id=? AND wanted=1",
            object?.version ?? row.version,
            row.id,
          );
          this.updateInfo(
            row,
            await instance.items.uploadAndPoll(row.key, content, {
              timeoutMs: 30_000,
              pollIntervalMs: 2_000,
              ...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
            }),
          );
        }
      } catch (error) {
        this.storage.sql.exec(
          "UPDATE search_items SET error=?,status=CASE WHEN attempts>=3 THEN 'error' ELSE 'pending' END WHERE id=?",
          errorCode(error) === "SEARCH_RECONCILE_REQUIRED"
            ? "SEARCH_RECONCILE_REQUIRED"
            : "SEARCH_UNAVAILABLE",
          row.id,
        );
      }
    }
    if (
      this.storage.sql
        .exec(
          "SELECT 1 FROM search_items WHERE (wanted=0 OR status IN ('pending','sending')) AND attempts<3 LIMIT 1",
        )
        .toArray().length
    )
      await this.wake();
  }
}
