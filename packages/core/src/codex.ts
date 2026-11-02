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
