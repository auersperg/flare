import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";
import { Session } from "./session.js";
import { allowedDestination, mcpUrl, scopePattern } from "./policy.js";

export class Outbound extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (
      !allowedDestination(url, mcpUrl(this.env.MCP_URL, this.env.FLARE_SCOPE))
    )
      return new Response("Destination denied", { status: 403 });
    // Redirects are returned to the container, where every subsequent hop is checked.
    return fetch(new Request(request, { redirect: "manual" }));
  }
}
export class CodexSession extends DurableObject<Env> {
  private session: Session;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw Error("CODEX_CONTAINER_UNAVAILABLE");
    this.session = new Session(
      ctx.storage,
      ctx.container,
      new Files(ctx.container),
      env,
      ctx.exports.Outbound as Fetcher,
    );
  }
  command(op: string, input: unknown) {
    return this.session.exclusive(() => this.session.command(op, input));
  }
  events(id: string, after: number) {
    return this.session.exclusive(() => this.session.events(id, after));
  }
  alarm() {
    return this.session.exclusive(() => this.session.tick());
  }
}
/** Private service binding only. No fetch API, login endpoint, or arbitrary exec RPC. */
export class CodexService extends WorkerEntrypoint<Env> {
  async events(scope: string, id: string, after: number) {
    try {
      if (!scopePattern.test(scope) || scope !== this.env.FLARE_SCOPE)
        throw Error("CODEX_SCOPE_MISMATCH");
      return {
        ok: true as const,
        value: await this.env.SESSION.getByName("codex").events(id, after),
      };
    } catch (error) {
      return {
        ok: false as const,
        code:
          error instanceof Error && /^CODEX_[A-Z_]+$/.test(error.message)
            ? error.message
            : "CODEX_UNAVAILABLE",
      };
    }
  }
  async command(scope: string, op: string, input: unknown) {
    try {
      if (!scopePattern.test(scope) || scope !== this.env.FLARE_SCOPE)
        throw Error("CODEX_SCOPE_MISMATCH");
      return {
        ok: true as const,
        value: await this.env.SESSION.getByName("codex").command(op, input),
      };
    } catch (error) {
      return {
        ok: false as const,
        code:
          error instanceof Error && /^CODEX_[A-Z_]+$/.test(error.message)
            ? error.message
            : "CODEX_UNAVAILABLE",
      };
    }
  }
}
export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
