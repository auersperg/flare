import { LIMITS } from "../../flare/src/sdk/protocol.js";
import { fail, status } from "./security.js";
import { scopeForDeletion } from "./maintenance.js";
export type FileInput = { name: string; type: string; size: number };
const types = new Set([
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "application/octet-stream",
]);
export function fileInput(input: FileInput): FileInput {
  if (
    !input ||
    typeof input.name !== "string" ||
    input.name.length < 1 ||
    input.name.length > 120 ||
    /[\x00-\x1f\x7f/\\]/.test(input.name) ||
    !types.has(input.type) ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    input.size > LIMITS.fileBytes
  )
    fail("INVALID_INPUT");
  return { name: input.name, type: input.type, size: input.size };
}
export function fileKey(scope: string, id: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id,
    )
  )
    fail("INVALID_INPUT");
  return `files/${scopeForDeletion(scope)}/${id}`;
}
export function fileOriginAllowed(
  origin: string,
  applicationOrigins: string[],
  dashboardUrl?: string,
) {
  if (applicationOrigins.includes(origin)) return true;
  if (!dashboardUrl) return false;
  const dashboard = new URL(dashboardUrl);
  return dashboard.protocol === "https:" && origin === dashboard.origin;
}
export class FileStore {
  constructor(
    private storage: DurableObjectStorage,
    private bucket: R2Bucket | undefined,
    private scope: string,
    private base: string,
    private wake: (at: number) => Promise<unknown>,
  ) {}
  static initialize(storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,size INTEGER NOT NULL,state TEXT NOT NULL,createdAt INTEGER NOT NULL,expires INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS files_page ON files(createdAt DESC,id)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS file_grants (ticket TEXT PRIMARY KEY,id TEXT NOT NULL,operation TEXT NOT NULL,expires INTEGER NOT NULL)",
    );
  }
  private enabled() {
    if (!this.bucket) fail("UNSUPPORTED");
    return this.bucket;
  }
  private url(operation: string, ticket: string) {
    return `${this.base.replace(/\/$/, "")}/p/${this.scope}/v1/files/${operation}?ticket=${ticket}`;
  }
  list(input: { cursor?: string | null; limit?: number } = {}) {
    this.enabled();
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      fail("INVALID_INPUT");
    let cursor: { at: number; id: string } | null = null;
    if (input.cursor != null) {
      try {
        if (typeof input.cursor !== "string" || input.cursor.length > 256)
          throw Error();
        cursor = JSON.parse(atob(input.cursor));
        if (!cursor || !Number.isSafeInteger(cursor.at) || cursor.at < 0)
          throw Error();
        fileKey(this.scope, cursor.id);
      } catch {
        fail("INVALID_CURSOR");
      }
    }
    const rows = this.storage.sql
      .exec(
        `SELECT id,name,type,size,state,createdAt FROM files ${cursor ? "WHERE createdAt<? OR (createdAt=? AND id>?)" : ""} ORDER BY createdAt DESC,id LIMIT ?`,
        ...(cursor ? [cursor.at, cursor.at, cursor.id] : []),
        limit + 1,
      )
      .toArray();
    const page = rows.slice(0, limit),
      last = page.at(-1);
    const isDone = rows.length <= limit;
    return {
      page,
      isDone,
      continueCursor:
        isDone || !last
          ? null
          : btoa(
              JSON.stringify({
                at: Number(last.createdAt),
                id: String(last.id),
              }),
            ),
    };
  }
  async reserve(input: FileInput) {
    this.enabled();
    const value = fileInput(input),
      id = crypto.randomUUID(),
      ticket = crypto.randomUUID() + crypto.randomUUID(),
      expires = Date.now() + 300000;
    const count = Number(
      this.storage.sql.exec("SELECT COUNT(*) n FROM files").one().n,
    );
    if (count >= 1000) fail("TOO_LARGE");
    await this.wake(expires + 30000); // Durable recovery is armed before reservation.
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT INTO files VALUES (?,?,?,?,?,?,?)",
        id,
        value.name,
        value.type,
        value.size,
        "pending",
        Date.now(),
        expires,
      );
      this.storage.sql.exec(
        "INSERT INTO file_grants VALUES (?,?,?,?)",
        ticket,
        id,
        "upload",
        expires,
      );
    });
    return { id, url: this.url("upload", ticket), expiresAt: expires };
  }
  grant(ticket: string, operation: string) {
    if (typeof ticket !== "string" || ticket.length !== 72)
      fail("UNAUTHORIZED");
    const grant = this.storage.sql
      .exec(
        "SELECT * FROM file_grants WHERE ticket=? AND operation=? AND expires>?",
        ticket,
        operation,
        Date.now(),
      )
      .toArray()[0];
    if (!grant) fail("UNAUTHORIZED");
    const row = this.storage.sql
      .exec("SELECT * FROM files WHERE id=?", grant.id)
      .toArray()[0];
    if (!row || row.state !== (operation === "upload" ? "pending" : "ready"))
      fail("NOT_FOUND");
    if (operation === "upload")
      this.storage.transactionSync(() => {
        this.storage.sql.exec("DELETE FROM file_grants WHERE ticket=?", ticket);
        this.storage.sql.exec(
          "UPDATE files SET state='uploading' WHERE id=?",
          row.id,
        );
      });
    return {
      id: String(row.id),
      name: String(row.name),
      type: String(row.type),
      size: Number(row.size),
    };
  }
  async downloadUrl(id: string) {
    fileKey(this.scope, id);
    this.enabled();
    if (
      !this.storage.sql
        .exec("SELECT id FROM files WHERE id=? AND state='ready'", id)
        .toArray().length
    )
      fail("NOT_FOUND");
    const ticket = crypto.randomUUID() + crypto.randomUUID(),
      expires = Date.now() + 300000;
    this.storage.sql.exec(
      "DELETE FROM file_grants WHERE expires<=?",
      Date.now(),
    );
    if (
      Number(
        this.storage.sql.exec("SELECT COUNT(*) n FROM file_grants").one().n,
      ) >= 2000
    )
      fail("TOO_LARGE");
    this.storage.sql.exec(
      "INSERT INTO file_grants VALUES (?,?,?,?)",
      ticket,
      id,
      "download",
      expires,
    );
    return { url: this.url("download", ticket), expiresAt: expires };
  }
  async complete(id: string) {
    const row = this.storage.sql
      .exec(
        "SELECT * FROM files WHERE id=? AND state IN ('uploading','ready')",
        id,
      )
      .toArray()[0];
    if (!row) fail("NOT_FOUND");
    if (row.state === "ready") return { id };
    const object = await this.enabled().head(fileKey(this.scope, id));
    if (!object || object.size !== Number(row.size)) fail("INVALID_INPUT");
    this.storage.sql.exec("UPDATE files SET state='ready' WHERE id=?", id);
    return { id };
  }
  async remove(id: string) {
    const key = fileKey(this.scope, id);
    this.enabled();
    const row = this.storage.sql
      .exec("SELECT id FROM files WHERE id=?", id)
      .toArray()[0];
    if (!row) return { deleted: false };
    await this.wake(Date.now() + 1000);
    this.storage.sql.exec(
      "UPDATE files SET state='deleting',expires=? WHERE id=?",
      Date.now(),
      id,
    );
    await this.enabled().delete(key);
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM file_grants WHERE id=?", id);
      this.storage.sql.exec("DELETE FROM files WHERE id=?", id);
    });
    return { deleted: true };
  }
  async sweep() {
    this.storage.sql.exec(
      "DELETE FROM file_grants WHERE expires<=?",
      Date.now(),
    );
    const rows = this.storage.sql
      .exec(
        "SELECT * FROM files WHERE state!='ready' AND expires<=? LIMIT 100",
        Date.now(),
      )
      .toArray();
    for (const row of rows) {
      const object = await this.enabled().head(
        fileKey(this.scope, String(row.id)),
      );
      if (row.state === "uploading" && object?.size === Number(row.size))
        this.storage.sql.exec(
          "UPDATE files SET state='ready' WHERE id=?",
          row.id,
        );
      else await this.remove(String(row.id));
    }
    const next = this.storage.sql
      .exec("SELECT MIN(expires) n FROM files WHERE state!='ready'")
      .one().n;
    if (next !== null)
      await this.wake(Math.max(Date.now() + 1000, Number(next) + 30000));
  }
}
/** Reservation must already have armed durable recovery. An uncertain metadata
 * acknowledgement must not erase bytes that R2 has successfully committed. */
export async function receiveUpload<T>(
  request: Request,
  bucket: R2Bucket,
  key: string,
  metadata: { size: number; type: string },
  complete: () => Promise<T>,
  remove: () => Promise<unknown>,
): Promise<T> {
  let stored = false;
  try {
    await streamUpload(request, bucket, key, metadata);
    stored = true;
    return await complete();
  } catch (error) {
    if (!stored || status(error).code === "NOT_FOUND") {
      await bucket.delete(key).catch(() => {});
      await remove().catch(() => {});
    }
    // Otherwise FileStore.sweep recovers the committed object from metadata.
    throw error;
  }
}
export async function streamUpload(
  request: Request,
  bucket: R2Bucket,
  key: string,
  metadata: { size: number; type: string },
) {
  // HTTP/2 and streamed clients need not supply Content-Length. The native
  // FixedLengthStream below still enforces the declared, bounded byte count.
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) !== metadata.size)
  )
    fail("INVALID_INPUT");
  if (!request.body && metadata.size !== 0) fail("INVALID_INPUT");
  const stream = new FixedLengthStream(metadata.size);
  const pumping = (
    request.body ??
    new ReadableStream({
      start(c) {
        c.close();
      },
    })
  ).pipeTo(stream.writable);
  const putting = bucket.put(key, stream.readable, {
    httpMetadata: { contentType: metadata.type },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  try {
    const [, object] = await Promise.all([pumping, putting]);
    if (!object) fail("CONFLICT");
  } catch (error) {
    await stream.readable.cancel().catch(() => {});
    await stream.writable.abort().catch(() => {});
    throw error;
  }
}
