import { appPolicy, type PolicyEnv } from "./capabilities.js";
import { codexInput } from "../../flare/src/sdk/codex.js";
import { FlareError } from "../../flare/src/sdk/protocol.js";

/** The app receives operations, never a runner binding or an OAuth credential. */
export async function codexCommand(
  env: PolicyEnv,
  scope: string,
  op: string,
  input: unknown,
) {
  codexInput(op, input);
  const name = appPolicy(env, scope).codex;
  if (!name)
    throw new FlareError(
      "CODEX_DISABLED",
      "Codex is not granted to this environment",
    );
  const binding = (env as Record<string, any>)[name];
  if (!binding || typeof binding.command !== "function")
    throw new FlareError(
      "CODEX_UNAVAILABLE",
      "Codex runner binding is missing",
    );
  const result = await binding.command(scope, op, input);
  if (!result.ok) throw new FlareError(result.code, result.code);
  return result.value;
}

/** Read-only application query authorizes each connection; no bearer ticket or public runner route. */
export async function codexEvents(
  env: PolicyEnv,
  scope: string,
  grant: any,
  after: number,
  guard: () => void,
) {
  if (
    !grant ||
    grant.type !== "codex-events" ||
    Object.keys(grant).some((k) => !["type", "id"].includes(k))
  )
    throw new FlareError(
      "INVALID_INPUT",
      "Expected a Codex subscription descriptor",
    );
  codexInput("status", { id: grant.id });
  if (!Number.isSafeInteger(after) || after < 0 || after > 4096)
    throw new FlareError("INVALID_INPUT", "Invalid event cursor");
  const name = appPolicy(env, scope).codex;
  if (!name) throw new FlareError("CODEX_DISABLED", "Codex is not granted");
  const binding = (env as Record<string, any>)[name];
  if (typeof binding?.events !== "function")
    throw new FlareError("CODEX_UNAVAILABLE", "Streaming is unavailable");
  guard();
  const result = await binding.events(scope, grant.id, after);
  if (!result.ok) throw new FlareError(result.code, result.code);
  const response: Response = result.value;
  if (!response.ok || !response.body)
    throw new FlareError("CODEX_UNAVAILABLE", "Streaming is unavailable");
  const reader = response.body.getReader();
  let closed = false;
  let lease: ReturnType<typeof setTimeout>,
    check: ReturnType<typeof setInterval>;
  const end = () => {
    if (closed) return;
    closed = true;
    clearTimeout(lease);
    clearInterval(check);
    void reader.cancel().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Re-run the app's read-only authorization query every 30 seconds on reconnect.
      lease = setTimeout(() => {
        if (!closed) {
          controller.close();
          end();
        }
      }, 30000);
      check = setInterval(() => {
        try {
          guard();
        } catch {
          if (!closed) {
            controller.error(Error("UNAUTHORIZED"));
            end();
          }
        }
      }, 5000);
    },
    async pull(controller) {
      try {
        guard();
        const next = await reader.read();
        if (closed) return;
        guard();
        if (next.done) {
          controller.close();
          end();
        } else controller.enqueue(next.value);
      } catch {
        if (!closed) {
          controller.error(Error("CODEX_STREAM_INTERRUPTED"));
          end();
        }
      }
    },
    cancel() {
      end();
    },
  });
}
