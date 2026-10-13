import type {
  RuntimeBinding,
  SupervisorBinding,
} from "../../packages/core/src/rpc-contract.js";
import type { AdminEnv, RuntimeEnv } from "../../packages/core/src/bindings.js";

// Compiled by tsc, never executed or sent to Cloudflare. Negative assertions
// become compiler failures if the contract widens back to string/any[].
function compileContracts(
  runtime: RuntimeBinding,
  supervisor: SupervisorBinding,
) {
  void runtime.command("configure", [
    { scope: "project/dev", origins: [], oidc: null },
  ]);
  void runtime.command("readiness", []);
  void supervisor.dispatch("call", [
    { path: "tasks/list", kind: "query", args: {}, auth: null },
  ]);
  // @ts-expect-error Unknown wire operation.
  void runtime.command("constructor", []);
  // @ts-expect-error Scope must be a string.
  void runtime.command("devIdentity", [12, "owner"]);
  void runtime.command("configure", [
    {
      scope: "project/dev",
      // @ts-expect-error Origins must be a string array.
      origins: 12,
      oidc: null,
    },
  ]);
  // @ts-expect-error Known operation requires its complete argument tuple.
  void supervisor.dispatch("configure", []);
  void supervisor.dispatch("call", [
    {
      path: "tasks/list",
      // @ts-expect-error Invocation kind is not an arbitrary string.
      kind: "unknown",
      args: {},
      auth: null,
    },
  ]);
  // @ts-expect-error Native request, not a string URL.
  void supervisor.fetch("https://example.test");
}
void compileContracts;

// Also exported for the configuration unit test; renaming a binding breaks tsc.
export const bindingNames = {
  admin: ["CATALOG", "RUNTIME", "ASSETS"] satisfies (keyof AdminEnv)[],
  runtime: [
    "LOADER",
    "SUPERVISORS",
    "BUNDLES",
    "FILES",
    "JOBS",
    "RATE_LIMITER",
    "ADMIN_API",
    "DEV_SIGNING_KEY",
  ] satisfies (keyof RuntimeEnv)[],
};
