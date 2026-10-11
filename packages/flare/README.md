# Flare 0.3 — SDK and CLI

Applications install one `@auersperg/flare` package, including the portable SDK and lazy Bun CLI. No internal package archives, ORM, Agents, Wrangler or workerd are installed into an application.

- `@auersperg/flare`: `createClient({url,getToken})`, references, errors, file upload helpers.
- `@auersperg/flare/react`: `FlareProvider`, `useFlare`, `useQuery(api.tasks.list,args)` → data or loading `undefined`.
- `@auersperg/flare/server`: `defineSchema`, `defineTable`, `z`, function declarations and contracts.
- `@auersperg/flare/cloudflare`: native facet/action factories, backend only.
- `@auersperg/flare/protocol`: transport types and limits.

```ts
// flare/schema.ts
import { defineSchema, defineTable, z } from "@auersperg/flare/server";
export default defineSchema({
  tasks: defineTable(
    z.object({ title: z.string(), done: z.boolean().default(false) }),
  ).index("by_done", ["done"]),
});
```

Functions import typed declarations from `./_generated/server`; `bunx --bun --package @auersperg/flare@next flare dev` generates this module before compilation. Read: `db.get(table,id)`, `db.query(table).withIndex(name,q=>q.eq(field,value)).order("desc").paginate({limit,cursor})`, `take(100)` and `first()`. Write: `insert`, `patch`, `replace`, `delete`; IDs and creation timestamps are automatic. Insert/replace accept validator input types, including omitted defaults. Queries expose no SQL, writes, session or storage capability.

Standard Schema / Standard JSON Schema validators define one contract for CLI, documents, function arguments/results and dashboard forms. All writes and schema activation validate data; reads decode already validated records, without running the same table validator again on each row. Output validation still applies to every function call. Mutations are transactional and capabilities expire when the invocation finishes. Unawaited database work and scheduled jobs must settle before commit.

0.3 is intentionally incompatible with the SQL/Drizzle API and release ABI 1–3. No compatibility adapters or historical app SQL journals remain. Use a fresh environment; local builds do not erase existing cloud data. Browser/server-JS clients remain portable; only CLI/build tooling requires Bun. No automatic retry of ambiguous mutations.

MIT-licensed; npm preview package `@auersperg/flare`. See the root architecture and maintenance documents for cloud acceptance and remaining product gates.

Scheduling: mutation `jobs.schedule(path,args,{delaySeconds})` and `jobs.cancel(id)` share the transaction. Cancel only removes a not-yet-enqueued outbox entry; it never aborts a running action. `paginate` adapts record count to its byte budget; `take` fails instead of silently truncating bulky results.

## Function model

Exactly three kinds: `query`, `mutation`, `action`. Declare each query once. JS: `client.onUpdate(ref,args,next,onError?)` delivers the first snapshot and later updates; `client.query(ref,args)` is the one-off alternative. Writes use `client.mutation`, external work uses `client.action`. The old `live`, `useLive`, `call` and `subscribe` APIs have been removed, not aliased. Regenerate references and redeploy applications with the updated CLI.

React uses one `useQuery(ref,args)` inside `FlareProvider`; `"skip"` makes no request. It returns values directly (not a custom result wrapper), handles cleanup and reconnect, and clears values for identity/auth changes. Function/auth errors reach the React error boundary. HTTP one-off reads do not require a persistent socket. Transport names such as `/v1/live` describe WebSockets, not another function type.

## Scoped files and background work

Actions use native scoped capabilities, not account-wide R2/Queue bindings. `ctx.files.list({limit:50,cursor})` returns `{page,isDone,continueCursor}`; pass the returned cursor to read the next page. No array alias or silent last-100 truncation remains. Upload/download grants expire, uploads stream to R2, and deletion invalidates outstanding download links.

Mutation outbox entries and data commit together. Native Queues batches confirm enqueue before removing outbox rows; retries remain per-message and at-least-once. Application external effects must use idempotency keys. Receipts have a bounded 30-day window, not perpetual exactly-once delivery.

## CLI

The CLI is compiled separately from the portable SDK in this package. Bun 1.4.3+; no local dashboard or emulator.

```sh
bun add @auersperg/flare@next       # npm preview, next tag
bunx --bun --package @auersperg/flare@next flare dev     # browser approval → project → native schema/types → cloud-dev watch
bunx --bun --package @auersperg/flare@next flare deploy  # build and confirm production deployment
```

Schema and functions live in `flare/`. `_generated/server.ts` supplies schema-typed query/mutation declarations; `_generated/api.ts` supplies browser-safe references. SQL journals and db-generation commands are not needed. Compilation/checksums happen locally, not on an application request. Frontend changes do not trigger backend deployment; framework-prefixed public URL env entries preserve other variables.

Advanced explicit commands:

```sh
flare build --entry app.ts --outdir release
flare link --platform https://api.example.com/control --project PROJECT_UUID
flare dev --entry app.ts
flare deploy --env dev --release release
```

Immutable output contains facet/action modules, `schema.json`, manifest, checksums, generated TypeScript API and OpenAPI 3.1. Only ABI 4 is accepted. No old `tables` declarations, `--migrations` flag or Drizzle pipeline.

Browser approval is protected by online Access/owner authorization and same-origin CSRF. Project-scoped credentials stay outside source/frontend env. Dev publishes to an already provisioned platform; general `platform init` is not implemented. No npm publication or cloud provisioning occurs during local verification.

## Immutable releases

```sh
bunx --bun --package @auersperg/flare@next flare releases --env dev
bunx --bun --package @auersperg/flare@next flare deploy --env prod --cmd "bun run build"
bunx --bun --package @auersperg/flare@next flare promote --env prod --hash DEV_BUILD_HASH --cmd "bun run build"
bunx --bun --package @auersperg/flare@next flare rollback --env prod --hash PREVIOUS_BUILD_HASH
```

History keeps the last five **distinct successful backend builds**, with their first publication date. Failed candidates are not promotable. Active builds and job/outbox references are protected from garbage collection. Repeating an unchanged build is not a new version.

Promote copies the selected immutable dev bundle to prod without recompiling or copying development data. Rollback activates compatible historical code against current data; it does not rewind the database. Both require explicit confirmation (`--confirm PROJECT_UUID` in CI), validate schema/job compatibility and compare the target's expected active hash. A changed target returns a conflict, never an automatic write retry.

`--cmd` generates client references for the exact selected bundle and builds the frontend **before** activating the backend. The child receives the selected environment URL via `FLARE_URL`, `PUBLIC_FLARE_URL`, `VITE_FLARE_URL`, `NEXT_PUBLIC_FLARE_URL` and `EXPO_PUBLIC_FLARE_URL`; local dev env files remain unchanged. A failed build does not publish backend code. Framework build variables must be public URLs, not credentials.

Frontend hosting stays with native Wrangler or another hosting tool. An application release script can sequence Flare + build + Wrangler. Frontend publication failure after backend activation is an explicit partial release, not an atomic transaction. Dashboard Health → Development/Production releases offers contract inspection, backend promotion and rollback on demand, with no polling. It does not publish the frontend.

Isolated historical preview environments and a paired frontend/backend version catalogue are not implemented. A saved backend hash is not a preview URL or a Git commit. Use additive contracts when old clients may remain active.

## On-demand backups

```sh
bunx --bun --package @auersperg/flare@next flare backup list --env dev
bunx --bun --package @auersperg/flare@next flare backup create --env dev --confirm PROJECT_UUID
bunx --bun --package @auersperg/flare@next flare backup restore --from dev --env prod --id BACKUP_UUID --confirm PROJECT_UUID
bunx --bun --package @auersperg/flare@next flare backup status --env prod
bunx --bun --package @auersperg/flare@next flare backup delete --env dev --id BACKUP_UUID --confirm PROJECT_UUID
```

Writes require owner access and explicit confirmation (interactive `yes`, or the project UUID in CI). Creation prints its ID before sending the request; after an uncertain response retry explicitly with `--id` and that same ID. No automatic write retry. Restore copies data, IDs, creation timestamps, files and the exact backend build into the **other, empty environment of the same project**. It does not promote a release or overwrite an occupied production database.

Pause cron and drain jobs/actions/uploads first. Limits: 10,000 documents / 4 MiB logical data, 100 files / 100 MiB. Secrets, environment settings, schedules and job history are not copied. Interrupted restores stay closed to application calls and deployments; retry the same backup ID. The source backup cannot be deleted while a restore references it. Private R2 backups occupy storage until explicitly deleted; no periodic backup timer or extra service is installed. See the maintenance guide for recovery limitations.

## Built-in application login

Owner enables authentication/public registration per environment in dashboard → Auth. No external provider is required for native passwords. Applications explicitly decide which functions are public; required remains the default. User role/ownership checks still belong in handlers.

```ts
import { createClient, createPasswordAuth } from "@auersperg/flare";
const url = import.meta.env.PUBLIC_FLARE_URL;
const auth = createPasswordAuth({ url });
const client = createClient({ url, getToken: auth.getToken });
const stopAuth = auth.onChange(() => client.refreshAuth());
await auth.register("my-login", "a long unique passphrase");
// Later: await auth.login(login, password), auth.me(), auth.changePassword(old, next).
await auth.logout();
stopAuth();
client.dispose();
```

Sessions are memory-only and expire after at most 12 hours. Reload requires login again. Password reset/block/revoke in Auth disconnects affected live users. Owner/Access manages accounts; application users and project CLI credentials do not gain dashboard privileges. Public login/registration have bounded rate limits; public registration is not equivalent to public access to private rows. Passwords require 6–128 characters. There is no email verification/recovery or MFA in this minimal version; owner reset is available. Existing short-lived R2 download grants remain valid for their explicit TTL, not until session logout.

## License and distribution

SDK and CLI are MIT-licensed; see LICENSE. npm name: `@auersperg/flare`.
The `flare` binary remains unchanged. Version 0.3.1 is published under the `next` tag. Core/dashboard are separate non-published
components and are not included in this package.
