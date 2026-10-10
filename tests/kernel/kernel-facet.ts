import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const counterV1 = sqliteTable("counter", {
  id: integer().primaryKey(),
  value: integer().notNull(),
  revision: integer().notNull(),
});
const counterV2 = sqliteTable("counter", {
  id: integer().primaryKey(),
  value: integer().notNull(),
  revision: integer().notNull(),
  label: text().notNull(),
});
const migrations = {
  m0000:
    "CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL, revision INTEGER NOT NULL);\n--> statement-breakpoint\nCREATE TABLE outbox (id TEXT PRIMARY KEY, release INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0);\n--> statement-breakpoint\nCREATE TABLE applied_jobs (id TEXT PRIMARY KEY);",
  m0001:
    "ALTER TABLE counter ADD COLUMN label TEXT NOT NULL DEFAULT 'preserved';",
  m0002:
    "UPDATE counter SET value=value+100;\n--> statement-breakpoint\nALTER TABLE counter ADD COLUMN label TEXT NOT NULL;",
};

declare const RELEASE: number;
export class AppFacet extends DurableObject<Record<string, never>> {
  readonly boot = crypto.randomUUID();
  readonly db;
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, {
        journal: {
          entries: Array.from({ length: RELEASE }, (_, idx) => ({
            idx,
            when: 1000 + idx,
            tag: `kernel-${idx}`,
            breakpoints: true,
          })),
        },
        migrations,
      });
      ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO counter (id,value,revision) VALUES (1,0,0)",
      );
    });
  }
  snapshot() {
    return {
      ...this.db
        .select()
        .from(RELEASE >= 2 ? counterV2 : counterV1)
        .get(),
      release: RELEASE,
      boot: this.boot,
    };
  }
  async mutate(options: { fail?: boolean; job?: string; appliedJob?: string }) {
    await this.ctx.storage.transaction(async () => {
      if (options.appliedJob) {
        const exists = this.ctx.storage.sql
          .exec("SELECT id FROM applied_jobs WHERE id=?", options.appliedJob)
          .toArray();
        if (exists.length) return;
        this.ctx.storage.sql.exec(
          "INSERT INTO applied_jobs VALUES (?)",
          options.appliedJob,
        );
      }
      this.ctx.storage.sql.exec(
        "UPDATE counter SET value=value+1, revision=revision+1 WHERE id=1",
      );
      if (options.job)
        this.ctx.storage.sql.exec(
          "INSERT INTO outbox (id,release) VALUES (?,?)",
          options.job,
          RELEASE,
        );
      await Promise.resolve();
      if (options.fail) throw new Error("KERNEL_ROLLBACK_SENTINEL");
    });
    await this.ctx.storage.sync();
    return this.snapshot();
  }
  pending() {
    return this.ctx.storage.sql
      .exec("SELECT id,release FROM outbox WHERE done=0 ORDER BY id")
      .toArray();
  }
  markSent(id: string) {
    this.ctx.storage.sql.exec("UPDATE outbox SET done=1 WHERE id=?", id);
  }
  async deniedFetch() {
    try {
      await fetch("https://example.com");
      return { denied: false };
    } catch {
      return { denied: true };
    }
  }
  parentIsolated() {
    return !this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name='supervisor_secret'")
      .toArray().length;
  }
}
export class Action extends WorkerEntrypoint {
  async run(payload: { id: string }) {
    console.log({
      source: "flared-kernel-action",
      jobId: payload.id,
      release: RELEASE,
    });
    return { id: payload.id, release: RELEASE };
  }
}
