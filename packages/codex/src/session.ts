import { eventStream, eventBytes } from "./stream.js";
import type { Files } from "@cloudflare/sandbox";
import { codexInput, type CodexTask } from "../../flare/src/sdk/codex.js";
import { boundedText, managedAuth, mcpUrl } from "./policy.js";

const dir = "/run/flare";
const retentionMs = 7 * 86400000;
const timeoutMs = 10 * 60000;
const pollMs = 5000;
type RecordTask = CodexTask & { fingerprint: string };
export interface Settings {
  FLARE_SCOPE: string;
  AUTH_REVISION: string;
  CODEX_AUTH_JSON: string;
  MCP_URL: string;
  FLARE_MCP_TOKEN?: string;
}

/** One serialized owner of a login and one running task. No queue or automatic replay. */
export class Session {
  private tail: Promise<unknown> = Promise.resolve();
  private watchers = 0;
  constructor(
    private storage: DurableObjectStorage,
    private container: Container,
    private files: Pick<Files, "readFile" | "writeFile">,
    private env: Settings,
    private outbound: Fetcher,
  ) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS codex_tasks (id TEXT PRIMARY KEY, finished_at INTEGER, record TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS codex_events (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
  }

  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  private task(id: string): RecordTask | undefined {
    const row = this.storage.sql
      .exec<{ record: string }>(
        "SELECT record FROM codex_tasks WHERE id = ?",
        id,
      )
      .toArray()[0];
    return row ? JSON.parse(row.record) : undefined;
  }
  private put(task: RecordTask) {
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO codex_tasks VALUES (?, ?, ?)",
      task.id,
      task.finishedAt ?? null,
      JSON.stringify(task),
    );
  }
  private visible(task?: RecordTask): CodexTask | null {
    if (!task) return null;
    const { fingerprint: _, ...result } = task;
    return result;
  }
  async command(op: string, input: any): Promise<CodexTask | null> {
    codexInput(op, input);
    const owner = this.storage.kv.get<string>("scope");
    if (owner && owner !== this.env.FLARE_SCOPE)
      throw Error("CODEX_SCOPE_MISMATCH");
    if (!owner) this.storage.kv.put("scope", this.env.FLARE_SCOPE);
    if (op === "status") return this.visible(this.task(input.id));
    if (op === "cancel") {
      if (
        this.storage.kv.get("active") === input.id &&
        this.task(input.id)?.state === "running"
      ) {
        if (this.container.running)
          await this.files.writeFile(`${dir}/cancel`, "1");
        await this.tick();
      }
      return this.visible(this.task(input.id));
    }
    const fingerprint = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(input.prompt),
        ),
      ),
    )
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    const existing = this.task(input.id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw Error("CODEX_ID_CONFLICT");
      return this.visible(existing);
    }
    if (this.storage.kv.get("active")) throw Error("CODEX_BUSY");
    // Bounded history and idempotency, cleaned only on demand, not by an idle cron.
    this.storage.sql.exec(
      "DELETE FROM codex_tasks WHERE finished_at < ?",
      Date.now() - retentionMs,
    );
    this.storage.sql.exec(
      "DELETE FROM codex_events WHERE id NOT IN (SELECT id FROM codex_tasks)",
    );
    const { count } = this.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM codex_tasks")
      .one();
    if (count >= 1000) throw Error("CODEX_HISTORY_FULL");
    const url = mcpUrl(this.env.MCP_URL, this.env.FLARE_SCOPE);
    if (url && !this.env.FLARE_MCP_TOKEN?.startsWith("flared_session_"))
      throw Error("CODEX_MCP_SESSION_REQUIRED");
    const auth = this.auth();
    const task: RecordTask = {
      id: input.id,
      state: "running",
      startedAt: Date.now(),
      fingerprint,
    };
    this.put(task);
    this.storage.kv.put("active", task.id);
    // Persist admission and its recovery alarm before any external execution.
    await this.storage.setAlarm(Date.now() + pollMs);
    let launchAttempted = false;
    try {
      this.container.start({
        image: this.container.images.codex,
        instance: "standard-1",
        enableInternet: false,
      });
      await this.container.interceptAllOutboundHttp(this.outbound);
      await this.container.interceptOutboundHttps("*", this.outbound);
      await this.container.setInactivityTimeout(30000);
      // /run is a fresh tmpfs on Cloudflare, not the directory baked into the image.
      const setup = await this.container.exec(
        ["sh", "-c", `mkdir -p ${dir}/codex && chmod 700 ${dir} ${dir}/codex`],
        { signal: AbortSignal.timeout(30000) },
      );
      if ((await setup.exitCode) !== 0) throw Error("CODEX_SETUP_FAILED");
      await this.files.writeFile(`${dir}/codex/auth.json`, auth);
      await this.files.writeFile(`${dir}/events.ndjson`, "");
      await this.files.writeFile(
        `${dir}/input.json`,
        JSON.stringify({ prompt: input.prompt, mcpUrl: url, timeoutMs }),
      );
      const ca = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
      launchAttempted = true;
      const process = await this.container.exec(
        [
          "sh",
          "-c",
          `chmod 600 ${dir}/codex/auth.json ${dir}/input.json; nohup node /opt/flare/run.mjs </dev/null >/dev/null 2>&1 &`,
        ],
        {
          env: {
            SSL_CERT_FILE: ca,
            NODE_EXTRA_CA_CERTS: ca,
            FLARE_MCP_TOKEN: this.env.FLARE_MCP_TOKEN ?? "",
          },
          signal: AbortSignal.timeout(30000),
        },
      );
      if ((await process.exitCode) !== 0) throw Error("CODEX_START_FAILED");
    } catch {
      // A lost launch reply can still mean the process ran. Never replay it.
      await this.finish(
        task,
        launchAttempted
          ? { state: "interrupted", error: "CODEX_START_UNCERTAIN" }
          : { state: "failed", error: "CODEX_SETUP_FAILED" },
        launchAttempted ? false : null,
      );
    }
    return this.visible(this.task(task.id));
  }
  async events(id: string, after: number) {
    codexInput("status", { id });
    if (!Number.isSafeInteger(after) || after < 0 || after > 4096)
      throw Error("CODEX_INVALID_CURSOR");
    const task = this.task(id);
    if (!task) throw Error("CODEX_TASK_NOT_FOUND");
    if (this.watchers >= 4) throw Error("CODEX_STREAM_LIMIT");
    let process: ExecProcess | undefined;
    if (task.state === "running" && this.container.running) {
      const pid = await this.read(`${dir}/pid`, 32);
      if (pid && /^\d+\s*$/.test(pid))
        process = await this.container.exec(
          [
            "tail",
            "-n",
            `+${after + 1}`,
            "-f",
            "--pid",
            pid.trim(),
            `${dir}/events.ndjson`,
          ],
          { stderr: "ignore", signal: AbortSignal.timeout(15000) },
        );
    }
    this.watchers++;
    return eventStream({
      after,
      process,
      archive: () =>
        this.storage.sql
          .exec<{ body: string }>(
            "SELECT body FROM codex_events WHERE id = ?",
            id,
          )
          .toArray()[0]?.body ?? "",
      task: () => this.visible(this.task(id)),
      settle: () =>
        this.task(id)?.state === "running"
          ? this.exclusive(() => this.tick())
          : Promise.resolve(),
      release: () => {
        this.watchers--;
      },
    });
  }
  private auth(): string {
    const revision = this.storage.kv.get<string>("auth-revision");
    if (!this.env.AUTH_REVISION) throw Error("CODEX_AUTH_REQUIRED");
    if (revision !== this.env.AUTH_REVISION) {
      const auth = managedAuth(this.env.CODEX_AUTH_JSON);
      this.storage.kv.put("auth", auth);
      this.storage.kv.put("auth-revision", this.env.AUTH_REVISION);
      this.storage.kv.delete("auth-invalid");
    }
    if (this.storage.kv.get("auth-invalid")) throw Error("CODEX_AUTH_REQUIRED");
    return managedAuth(this.storage.kv.get<string>("auth") ?? "");
  }
  private async read(path: string, max: number): Promise<string | undefined> {
    try {
      return await boundedText(await this.files.readFile(path), max);
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "SandboxFileError" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return undefined;
      throw error;
    }
  }
  private async checkpoint() {
    const auth = managedAuth(
      (await this.read(`${dir}/codex/auth.json`, 65536)) ?? "",
    );
    if (this.storage.kv.get("auth") !== auth) this.storage.kv.put("auth", auth);
  }
  private async finish(
    task: RecordTask,
    outcome: Partial<CodexTask>,
    checkpoint: boolean | null,
  ) {
    if (checkpoint) {
      try {
        await this.checkpoint();
      } catch {
        this.storage.kv.put("auth-invalid", true);
        outcome = {
          state: "interrupted",
          error: "CODEX_AUTH_CHECKPOINT_FAILED",
        };
      }
    } else if (checkpoint === false) this.storage.kv.put("auth-invalid", true);
    if (this.container.running) {
      const body = await this.read(`${dir}/events.ndjson`, eventBytes).catch(
        () => undefined,
      );
      if (body !== undefined)
        this.storage.sql.exec(
          "INSERT OR REPLACE INTO codex_events VALUES (?, ?)",
          task.id,
          body,
        );
    }
    // Commit result and rotated credentials before destroying ephemeral disk.
    this.put({ ...task, ...outcome, finishedAt: Date.now() });
    await this.storage.sync();
    await this.stop();
  }
  private async stop() {
    if (this.container.running) await this.container.destroy();
    this.storage.kv.delete("active");
    await this.storage.deleteAlarm();
  }
  async tick(): Promise<void> {
    const id = this.storage.kv.get<string>("active");
    if (!id) {
      await this.storage.deleteAlarm();
      return;
    }
    // Recovery includes failed stop/checkpoint attempts and DO eviction.
    await this.storage.setAlarm(Date.now() + pollMs);
    const task = this.task(id)!;
    if (task.state !== "running") {
      await this.stop();
      return;
    }
    if (this.storage.kv.get("scope") !== this.env.FLARE_SCOPE) {
      await this.finish(
        task,
        { state: "interrupted", error: "CODEX_SCOPE_MISMATCH" },
        false,
      );
      return;
    }
    if (!this.container.running) {
      await this.finish(
        task,
        { state: "interrupted", error: "CODEX_CONTAINER_LOST" },
        false,
      );
      return;
    }
    if (Date.now() > task.startedAt + timeoutMs + 60000) {
      await this.finish(
        task,
        { state: "interrupted", error: "CODEX_DEADLINE_EXCEEDED" },
        false,
      );
      return;
    }
    try {
      const raw = await this.read(`${dir}/outcome.json`, 1024);
      if (raw === undefined) {
        // Save refreshes during a long task too. An abrupt host loss still requires
        // a fresh login: a token rotation may have occurred since this checkpoint.
        await this.checkpoint();
        return;
      }
      const outcome = JSON.parse(raw);
      if (outcome.reason === "CANCELLED")
        await this.finish(task, { state: "cancelled" }, true);
      else if (outcome.exitCode !== 0 || outcome.reason)
        await this.finish(
          task,
          {
            state: "failed",
            error:
              outcome.reason === "TIMEOUT"
                ? "CODEX_TIMEOUT"
                : "CODEX_EXEC_FAILED",
          },
          true,
        );
      else {
        const result = await this.read(`${dir}/result.txt`, 65536);
        await this.finish(
          task,
          result === undefined
            ? { state: "failed", error: "CODEX_RESULT_MISSING" }
            : { state: "succeeded", result },
          true,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "CODEX_OUTPUT_TOO_LARGE"
      ) {
        await this.finish(
          task,
          { state: "failed", error: "CODEX_OUTPUT_TOO_LARGE" },
          true,
        );
      }
      // No raw exception, stderr or credential content crosses the RPC boundary.
      // Transient reads retry until the fixed deadline, never rerun Codex.
    }
  }
}
