# Optional private Codex runner

Flare action → private Service Binding → one Durable Object / Linux container → official Codex App Server. Codex owns the agent loop and ChatGPT OAuth refresh. No model proxy, second agent framework, queue, public runner API, or always-on process is added to the platform.

This package is deployed **separately and only when enabled**. The normal Flare install/update does not build or provision containers. Its managed configuration stores only a service reference; the runner's secrets and lifecycle remain operator-owned. Removing a reference does not delete the runner.

## Trust boundary

Only grant this capability to your own **trusted private automation**, not a public prompt endpoint, untrusted app, shared model service, or untrusted repository/PR. Actions must enforce their own owner authorization. All granted actions share this runner's tasks and subscription limits; task IDs are not an authorization mechanism.

The app receives task operations, never a credential binding or an arbitrary shell RPC. However, **Codex and commands it executes inside the container can read its login file**. Container isolation does not protect credentials from the agent itself or from malicious instructions. Do not promise otherwise. Only the official Codex backend, native workspace-discovery endpoints, its token-refresh endpoint, and an optional exact Flare MCP URL are reachable. No general Internet, GitHub, package installation, API-key fallback, or AI Gateway billing route is enabled.

See the official [Cloudflare Codex runner](https://developers.cloudflare.com/sandbox/coding-agents/codex/) and [OpenAI's trusted private account-auth workflow](https://learn.chatgpt.com/docs/auth/ci-cd-auth). The latter is an advanced account-auth option; OpenAI recommends API keys for most automation. Subscription limits still apply, and Cloudflare compute/storage is billed separately.

## Operator setup

Requires Workers Paid, Containers access, Docker, and the repository's pinned Wrangler. The compatibility date matches the repository's workerd version. Sandbox package and image are both pinned to 1.0.3; Codex is pinned to 0.166.0.

Create a **dedicated login**. Do not copy the login used concurrently by your desktop or another runner:

```sh
mkdir -p .private/codex-login
chmod 700 .private/codex-login
CODEX_HOME="$PWD/.private/codex-login" codex \
  -c 'cli_auth_credentials_store="file"' login --device-auth
```

Use a distinct Worker name and login for each project/environment. `FLARE_SCOPE` is the exact `project-uuid/dev` or `project-uuid/prod`. It is pinned in durable storage on first use; never repurpose an existing runner for another scope.

```sh
# Replace these two values with the intended private runner and real project scope.
RUNNER=your-private-codex-runner
SCOPE=your-project-uuid/dev
CONFIG=packages/codex/wrangler.jsonc

node node_modules/wrangler/bin/wrangler.js secret put CODEX_AUTH_JSON \
  --config "$CONFIG" --name "$RUNNER" < .private/codex-login/auth.json
node node_modules/wrangler/bin/wrangler.js deploy --config "$CONFIG" \
  --name "$RUNNER" --var "FLARE_SCOPE:$SCOPE" --var AUTH_REVISION:1
```

Always supply the same scope on subsequent deployments (or maintain an operator-owned Wrangler configuration with the equivalent absolute source/Dockerfile paths). Never commit login files or put them in vars, app secrets, prompts, logs, platform configuration, or task results. After provisioning, remove the local dedicated login copy; the runner is its sole owner.

The seed secret is read only for a new `AUTH_REVISION`. Updated credentials are held in private Durable Object storage. It is safe to delete the seed secret after the first successful run; if doing so, also remove it from the operator configuration's `secrets.required` before future deploys. Never overwrite rotated credentials with the original seed on every invocation. To recover a revoked/uncertain login, create a fresh dedicated login, replace the seed secret, and deploy with a new revision while idle.

Add a reference and explicit grant to the existing Flare operator configuration and apply it through the normal managed platform update:

```json
{
  "codex": [
    {
      "binding": "APP_CODEX_PERSONAL",
      "service": "your-private-codex-runner",
      "scope": "your-project-uuid/dev"
    }
  ],
  "capabilities": {
    "your-project-uuid/dev": { "codex": "APP_CODEX_PERSONAL" }
  }
}
```

Only Runtime receives the `CodexService` binding. Admin, browser code, queries and mutations do not receive it. An action can call:

```ts
// After checking that ctx.auth is the authorized owner:
const task = await ctx.codex.start({ id: requestId, prompt });
// Later calls, with the same owner authorization:
const state = await ctx.codex.status(task.id);
await ctx.codex.cancel(task.id);
```

`requestId` must be a stable UUID. Retrying `start` with the same UUID and prompt returns the recorded task; a changed prompt is rejected. Never automatically retry an interrupted task under a new UUID: its external effects may already have happened.

### Optional Flare MCP

Set `MCP_URL` to `https://runtime-host/p/<same-project>/<same-env>/v1/mcp` and store a real, least-privilege app-user session as the runner secret `FLARE_MCP_TOKEN` using `wrangler secret put`. This uses Codex's native HTTP MCP client and Flare's existing tool ACLs. No owner impersonation or second MCP server is introduced. The app session expires independently of Codex login: renew it through the app's normal login flow and update the secret. Do not use deploy/admin/OIDC tokens. Without these settings the runner has no Flare tools. Automatic ChatGPT app integrations and plugins are disabled; only the explicitly configured MCP server is used.

## Lifecycle and limits

- One active task per login; concurrent different submissions return `CODEX_BUSY`, rather than silently queueing.
- Input up to 16 KiB, final text up to 64 KiB, execution deadline 10 minutes. Commands run only in an ephemeral `/workspace`; no Git checkout, artifacts, workspace snapshot or conversation history is retained.
- A native DO alarm observes completion every five seconds and checkpoints rotated auth. A process watchdog also enforces the deadline independently of the Worker.
- Before destruction, the runner commits final auth and result and flushes durable writes. It normally stops within one polling interval of task completion. With no active task there is no alarm or keepalive.
- A 30-second container inactivity timeout is a fallback, not the normal shutdown path. Abrupt host loss or ambiguous launch yields `interrupted`, disables reuse of potentially stale refresh tokens, and requires a fresh login. There is no automatic mutation replay.
- At most 1,000 result/idempotency records are kept. Finished records older than seven days are deleted on the next new submission, without scanning result bodies or running an idle cleanup service. At capacity, new work fails rather than silently evicting recent idempotency records.
- Results are not per-app-user isolated. Only trusted owner actions may expose them. Errors never return raw stderr or credential material.

To remove: stop accepting submissions, wait for or cancel the active task, remove the capability grant/reference through the managed update, revoke the dedicated Codex login, then delete the runner and its container resources through Wrangler. Do not assume deleting a Flare project or its service reference also deletes operator-owned resources.

## Verification

```sh
bun test tests/codex.test.ts tests/codex-config.test.mjs
bun x tsc --noEmit -p packages/codex/tsconfig.json
bun run test:codex:local
```

The local native acceptance test uses real workerd, Service Binding RPC, SQLite, Sandbox files and Docker, but substitutes a deterministic Codex process. It checks successful/failed/cancelled execution, rotated-auth persistence, cold restart, duplicate suppression, scope rejection and container shutdown. It never reads an account login or calls a model. A real subscription/cloud test requires separate explicit operator approval.

Cloud proof on 2026-11-02: two real Codex tasks returned `FLARE_CODEX_OK` using a dedicated ChatGPT login. The second ran after deletion of the bootstrap secret and redeployment, using only persisted credentials. Cloudflare reported zero active container instances afterwards. The test Worker, DO namespace, container application and all test image tags were removed. Real token rotation was not triggered by changing `last_refresh` with CLI 0.166.0; rotated-file persistence is covered by the local fixture, not claimed as a live refresh proof.

## Live events (0.3.12)

The same pinned official Codex binary runs `app-server --listen stdio://` **only for one task**. Its native `item/agentMessage/delta` and command lifecycle/output notifications drive the UI; there is no simulated typing or status-polling substitute. The small process client still owns only startup, deadline, cancellation and shutdown, not the model/tool loop. A new ephemeral thread is used for each task.

Only allowlisted display fields are written to a bounded 256 KiB / 4,096-event NDJSON journal. Account/auth frames, raw stderr, private reasoning and arbitrary protocol objects are never forwarded. Known runner OAuth/MCP credentials are redacted, including split text deltas. This is defense in depth, **not a guarantee against a malicious agent encoding secrets**: the trusted-owner restriction remains essential.

Cloudflare's native container `exec()` follows the journal using `tail`, returning a byte stream over the existing private Service Binding. Disconnect stops only this follower, never the task. The journal is checkpointed to the same DO's SQLite storage before container teardown and pruned with its seven-day task history. No extra database, queue, public runner URL or always-on process is added. Old tasks from before 0.3.12 can return their final state without an event history.

The app exposes an owner-authorized **read-only query**, not an action that may replay mutations:

```ts
export const watch = query({
  auth: "required",
  input: z.object({ id: z.uuid() }),
  output: z.object({ type: z.literal("codex-events"), id: z.uuid() }),
  handler: ({ auth }, { id }) => {
    requireOwner(auth); // your existing application authorization
    return { type: "codex-events" as const, id };
  },
});

for await (const event of client.codexEvents(
  api.ai.watch,
  { id },
  { signal },
)) {
  // text/output/item/status/truncated events, followed by the final task
}
```

The descriptor is not a credential. `POST /v1/codex/events` uses the existing Bearer session, origin checks, app query ACL and explicit environment Codex grant. The authenticated SDK reads SSE with `fetch`, never puts tokens in URLs, reconnects with the last event ID and deduplicates replay. Reconnecting cannot start a task. A 30-second connection lease re-runs app authorization; session expiry/revocation is also checked on chunks and every five seconds while connected. Logout/client disposal aborts its streams. Slow readers are disconnected with bounded buffering and can resume. Four concurrent followers per runner are allowed; completed-task replay does not restart a container.

When the trace limit is reached, a `truncated` event is explicit; task execution and its separately bounded final answer continue. Model command output may arrive in batches if the underlying tool buffers stdout; text deltas are forwarded as Codex emits them, not split artificially.
