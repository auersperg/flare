import { validateAuthBackup, type AuthBackupUser } from "./auth.js";
import { boundedJson, stableJson } from "../../flare/src/sdk/protocol.js";
import {
  SNAPSHOT_BYTES,
  type DataSnapshot,
} from "../../flare/src/sdk/backup.js";
import { fileInput, fileKey, type FileInput } from "./files.js";
import { scopeForDeletion } from "./maintenance.js";
import { digest, fail, uuid } from "./security.js";
import { validateRelease, type ReleaseUpload } from "./release.js";

export type BackupFile = FileInput & {
  id: string;
  createdAt: number;
  md5: string;
};
export type Backup = {
  format: 1;
  id: string;
  scope: string;
  at: number;
  bundle: ReleaseUpload;
  data: DataSnapshot;
  files: BackupFile[];
  authUsers?: AuthBackupUser[];
};
export const BACKUP_BYTES = SNAPSHOT_BYTES + 4 * 1048576;
export const BACKUP_FILES = 100;
export const BACKUP_FILE_BYTES = 100 * 1048576;
export function backupPrefix(scope: string, id?: string) {
  return `backups/${scopeForDeletion(scope)}/${id === undefined ? "" : uuid(id) + "/"}`;
}
/** Private R2 prefix, commit-last manifest, streamed file copies. No public URLs or session tokens; password hashes remain inside private capsules. */
export class BackupStore {
  constructor(
    private bucket: R2Bucket,
    private files: R2Bucket | undefined,
  ) {}
  async completed(scope: string, id: string) {
    return !!(await this.bucket.head(backupPrefix(scope, id) + "manifest.json"))
      ?.customMetadata?.sha256;
  }
  async read(scope: string, id: string): Promise<Backup | null> {
    const object = await this.bucket.get(
      backupPrefix(scope, id) + "manifest.json",
    );
    if (!object) return null;
    if (object.size > BACKUP_BYTES) fail("BACKUP_TOO_LARGE");
    const encoded = await object.text();
    if ((await digest(encoded)) !== object.customMetadata?.sha256)
      fail("INVALID_BACKUP");
    const value: Backup = JSON.parse(encoded);
    if (
      value.format !== 1 ||
      value.id !== id ||
      value.scope !== scope ||
      !Number.isSafeInteger(value.at) ||
      !Array.isArray(value.files) ||
      value.files.length > BACKUP_FILES
    )
      fail("INVALID_BACKUP");
    if (value.authUsers !== undefined) validateAuthBackup(value.authUsers);
    boundedJson(value.data, SNAPSHOT_BYTES);
    await validateRelease(value.bundle);
    if (stableJson(value.data.schema) !== stableJson(value.bundle.schema))
      fail("INVALID_BACKUP");
    const ids = new Set<string>();
    let bytes = 0;
    for (const file of value.files) {
      fileInput(file);
      fileKey(scope, file.id);
      if (
        ids.has(file.id) ||
        !Number.isSafeInteger(file.createdAt) ||
        file.createdAt < 0 ||
        !/^[a-f0-9]{32}$/.test(file.md5)
      )
        fail("INVALID_BACKUP");
      ids.add(file.id);
      bytes += file.size;
    }
    if (bytes > BACKUP_FILE_BYTES) fail("BACKUP_TOO_LARGE");
    return value;
  }
  async create(value: Omit<Backup, "files">, files: Omit<BackupFile, "md5">[]) {
    const existing = await this.read(value.scope, value.id);
    if (existing) return this.summary(existing);
    if (
      files.length > BACKUP_FILES ||
      files.reduce((n, f) => n + f.size, 0) > BACKUP_FILE_BYTES
    )
      fail("BACKUP_TOO_LARGE");
    if (files.length && !this.files) fail("UNSUPPORTED");
    const prefix = backupPrefix(value.scope, value.id),
      copied: BackupFile[] = [];
    for (const file of files) {
      const object = await this.files!.get(fileKey(value.scope, file.id));
      if (
        !object ||
        object.size !== file.size ||
        !/^[a-f0-9]{32}$/.test(object.etag)
      )
        fail("INVALID_BACKUP");
      const stored = await this.bucket.put(
        prefix + "files/" + file.id,
        object.body,
        {
          md5: object.etag,
          httpMetadata: { contentType: file.type },
        },
      );
      if (!stored || stored.size !== file.size || stored.etag !== object.etag)
        fail("INVALID_BACKUP");
      copied.push({ ...file, md5: stored.etag });
    }
    const backup: Backup = { ...value, files: copied },
      encoded = boundedJson(backup, BACKUP_BYTES);
    const stored = await this.bucket.put(prefix + "manifest.json", encoded, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: {
        sha256: await digest(encoded),
        release: value.bundle.release.hash,
        at: String(value.at),
        revision: String(value.data.revision),
        rows: String(this.summary(backup).rows),
        files: String(backup.files.length),
      },
      httpMetadata: { contentType: "application/json" },
    });
    // A lost acknowledgement can be checked by ID. Never delete a possibly committed backup.
    if (!stored) fail("CONFLICT");
    return this.summary(backup);
  }
  summary(value: Backup) {
    return {
      id: value.id,
      scope: value.scope,
      at: value.at,
      hash: value.bundle.release.hash,
      revision: value.data.revision,
      rows: Object.values(value.data.tables).reduce(
        (n, rows) => n + rows.length,
        0,
      ),
      files: value.files.length,
    };
  }
  async list(scope: string, cursor?: string) {
    if (cursor && (typeof cursor !== "string" || cursor.length > 2048))
      fail("INVALID_CURSOR");
    // Prefix+delimiter avoids enumerating copied file blobs. Each page is bounded.
    const page = await this.bucket.list({
      prefix: backupPrefix(scope),
      delimiter: "/",
      limit: 20,
      cursor,
    });
    const backups = [];
    for (const prefix of page.delimitedPrefixes) {
      const id = prefix.slice(backupPrefix(scope).length, -1);
      const manifest = await this.bucket.head(prefix + "manifest.json"),
        meta = manifest?.customMetadata;
      backups.push(
        meta
          ? {
              id,
              scope,
              at: Number(meta.at),
              hash: meta.release,
              revision: Number(meta.revision),
              rows: Number(meta.rows),
              files: Number(meta.files),
            }
          : { id, scope, state: "incomplete" },
      );
    }
    return { page: backups, cursor: page.truncated ? page.cursor : null };
  }
  async copyFiles(value: Backup, target: string) {
    if (value.files.length && !this.files) fail("UNSUPPORTED");
    for (const file of value.files) {
      const object = await this.bucket.get(
        backupPrefix(value.scope, value.id) + "files/" + file.id,
        { onlyIf: { etagMatches: file.md5 } },
      );
      if (
        !object ||
        !("body" in object) ||
        !object.body ||
        object.size !== file.size
      )
        fail("INVALID_BACKUP");
      const stored = await this.files!.put(
        fileKey(target, file.id),
        object.body,
        {
          md5: file.md5,
          httpMetadata: { contentType: file.type },
        },
      );
      if (!stored || stored.size !== file.size || stored.etag !== file.md5)
        fail("INVALID_BACKUP");
    }
  }
  async remove(scope: string, id: string) {
    const prefix = backupPrefix(scope, id);
    // Hide the manifest first, so an interrupted deletion never advertises a complete backup.
    await this.bucket.delete(prefix + "manifest.json");
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor });
      if (page.objects.length)
        await this.bucket.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return { deleted: true, id };
  }
}

type BackupSummary = ReturnType<BackupStore["summary"]>;
/** Rebuildable metadata index in the owning Supervisor, not another backup
 * service. Legacy UUID capsules are discovered 20 at a time; incomplete scans
 * never advertise an authoritative recovery point. No timer or blob reads. */
export class BackupInventory {
  constructor(
    private storage: DurableObjectStorage,
    private store: BackupStore,
    private scope: string,
  ) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS backup_inventory (id INTEGER PRIMARY KEY,cursor TEXT,complete INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "INSERT OR IGNORE INTO backup_inventory VALUES (1,NULL,0)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS backup_index (id TEXT PRIMARY KEY,at INTEGER NOT NULL,summary TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS backup_index_at ON backup_index(at DESC,id DESC)",
    );
  }
  async record(summary: BackupSummary) {
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO backup_index VALUES (?,?,?)",
      summary.id,
      summary.at,
      JSON.stringify(summary),
    );
    await this.storage.sync();
    return summary;
  }
  async remove(id: string) {
    // Manifest deletion may succeed while blob cleanup loses its response.
    // Never keep advertising a deleted recovery point during that ambiguity.
    this.storage.sql.exec("DELETE FROM backup_index WHERE id=?", id);
    this.storage.sql.exec(
      "UPDATE backup_inventory SET cursor=NULL,complete=0 WHERE id=1",
    );
    await this.storage.sync();
    return this.store.remove(this.scope, id);
  }
  async list(cursor?: string) {
    if (cursor && (typeof cursor !== "string" || cursor.length > 2048))
      fail("INVALID_CURSOR");
    let before: { at: number; id: string; scope: string } | undefined;
    if (cursor) {
      try {
        before = JSON.parse(atob(cursor));
      } catch {
        fail("INVALID_CURSOR");
      }
      if (
        !before ||
        before.scope !== this.scope ||
        !Number.isSafeInteger(before.at) ||
        before.at < -1
      )
        fail("INVALID_CURSOR");
      uuid(before.id);
    }
    const checkpoint = this.storage.sql
      .exec("SELECT cursor,complete FROM backup_inventory WHERE id=1")
      .one();
    if (!checkpoint.complete) {
      const result = await this.store.list(
        this.scope,
        checkpoint.cursor == null ? undefined : String(checkpoint.cursor),
      );
      // Commit progress only after all metadata reads succeeded. Restart is safe.
      for (const item of result.page)
        this.storage.sql.exec(
          "INSERT OR REPLACE INTO backup_index VALUES (?,?,?)",
          item.id,
          "at" in item ? item.at : -1,
          JSON.stringify(item),
        );
      this.storage.sql.exec(
        "UPDATE backup_inventory SET cursor=?,complete=? WHERE id=1",
        result.cursor,
        result.cursor ? 0 : 1,
      );
      await this.storage.sync();
    }
    const complete = !!this.storage.sql
      .exec("SELECT complete FROM backup_inventory WHERE id=1")
      .one().complete;
    const rows = before
      ? this.storage.sql
          .exec(
            "SELECT * FROM backup_index WHERE at<? OR (at=? AND id<?) ORDER BY at DESC,id DESC LIMIT 21",
            before.at,
            before.at,
            before.id,
          )
          .toArray()
      : this.storage.sql
          .exec("SELECT * FROM backup_index ORDER BY at DESC,id DESC LIMIT 21")
          .toArray();
    const page = rows.slice(0, 20).map((r) => JSON.parse(String(r.summary)));
    const last = rows[19];
    const newest = complete
      ? this.storage.sql
          .exec(
            "SELECT summary FROM backup_index WHERE at>=0 ORDER BY at DESC,id DESC LIMIT 1",
          )
          .toArray()[0]
      : undefined;
    const latest = newest
      ? (JSON.parse(String(newest.summary)) as BackupSummary)
      : null;
    if (latest && !(await this.store.completed(this.scope, latest.id))) {
      this.storage.sql.exec("DELETE FROM backup_index WHERE id=?", latest.id);
      this.storage.sql.exec(
        "UPDATE backup_inventory SET cursor=NULL,complete=0 WHERE id=1",
      );
      await this.storage.sync();
      return {
        page: page.filter((r) => r.id !== latest.id),
        cursor: null,
        inventory: "partial",
        latest: null,
        recoveryPoint: "unknown",
        ageMs: null,
      };
    }
    return {
      page,
      cursor:
        rows.length > 20
          ? btoa(
              JSON.stringify({
                scope: this.scope,
                at: Number(last.at),
                id: String(last.id),
              }),
            )
          : null,
      inventory: complete ? "complete" : "partial",
      latest,
      recoveryPoint: !complete
        ? "unknown"
        : !latest
          ? "missing"
          : Date.now() - latest.at > 86400000
            ? "overdue"
            : "within-24h",
      ageMs: latest ? Math.max(0, Date.now() - latest.at) : null,
    };
  }
}
