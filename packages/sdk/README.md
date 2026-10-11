# Flared SDK 0.3 — native document API

Internal source workspace; applications install one `flared` package, including the portable SDK and lazy Bun CLI. No internal package archives, ORM, Agents, Wrangler or workerd are installed into an application.

- `flared`: `createClient({url,getToken})`, references, errors, file upload helpers.
- `flared/react`: `FlaredProvider`, `useFlared`, `useQuery(api.tasks.list,args)` → data or loading `undefined`.
- `flared/server`: `defineSchema`, `defineTable`, `z`, function declarations and contracts.
- `flared/cloudflare`: native facet/action factories, backend only.
- `flared/protocol`: transport types and limits.

```ts
// flared/schema.ts
import { defineSchema, defineTable, z } from "flared/server";
export default defineSchema({
  tasks: defineTable(
    z.object({ title: z.string(), done: z.boolean().default(false) }),
  ).index("by_done", ["done"]),
});
```

Functions import typed declarations from `./_generated/server`; `bunx flared dev` generates this module before compilation. Read: `db.get(table,id)`, `db.query(table).withIndex(name,q=>q.eq(field,value)).order("desc").paginate({limit,cursor})`, `take(100)` and `first()`. Write: `insert`, `patch`, `replace`, `delete`; IDs and creation timestamps are automatic. Insert/replace accept validator input types, including omitted defaults. Queries expose no SQL, writes, session or storage capability.

Standard Schema / Standard JSON Schema validators define one contract for CLI, documents, function arguments/results and dashboard forms. All writes and schema activation validate data; reads decode already validated records, without running the same table validator again on each row. Output validation still applies to every function call. Mutations are transactional and capabilities expire when the invocation finishes. Unawaited database work and scheduled jobs must settle before commit.

0.3 is intentionally incompatible with the SQL/Drizzle API and release ABI 1–3. No compatibility adapters or historical app SQL journals remain. Use a fresh environment; local builds do not erase existing cloud data. Browser/server-JS clients remain portable; only CLI/build tooling requires Bun. No automatic retry of ambiguous mutations.

Private, unpublished, UNLICENSED. See the root architecture and maintenance documents for cloud acceptance and remaining product gates.

Scheduling: mutation `jobs.schedule(path,args,{delaySeconds})` and `jobs.cancel(id)` share the transaction. Cancel only removes a not-yet-enqueued outbox entry; it never aborts a running action. `paginate` adapts record count to its byte budget; `take` fails instead of silently truncating bulky results.

## Function model

Exactly three kinds: `query`, `mutation`, `action`. Declare each query once. JS: `client.onUpdate(ref,args,next,onError?)` delivers the first snapshot and later updates; `client.query(ref,args)` is the one-off alternative. Writes use `client.mutation`, external work uses `client.action`. The old `live`, `useLive`, `call` and `subscribe` APIs have been removed, not aliased. Regenerate references and redeploy applications with the updated CLI.

React uses one `useQuery(ref,args)` inside `FlaredProvider`; `"skip"` makes no request. It returns values directly (not a custom result wrapper), handles cleanup and reconnect, and clears values for identity/auth changes. Function/auth errors reach the React error boundary. HTTP one-off reads do not require a persistent socket. Transport names such as `/v1/live` describe WebSockets, not another function type.

## Scoped files and background work

Actions use native scoped capabilities, not account-wide R2/Queue bindings. `ctx.files.list({limit:50,cursor})` returns `{page,isDone,continueCursor}`; pass the returned cursor to read the next page. No array alias or silent last-100 truncation remains. Upload/download grants expire, uploads stream to R2, and deletion invalidates outstanding download links.

Mutation outbox entries and data commit together. Native Queues batches confirm enqueue before removing outbox rows; retries remain per-message and at-least-once. Application external effects must use idempotency keys. Receipts have a bounded 30-day window, not perpetual exactly-once delivery.
