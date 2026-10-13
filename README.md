# Flare

[![CI](https://github.com/auersperg/flare/actions/workflows/ci.yml/badge.svg)](https://github.com/auersperg/flare/actions/workflows/ci.yml)

Cloudflare-native reactive backend in your own account.

**0.3 · breaking native-data preview.** One installation, multiple projects, isolated cloud `dev` / `prod`. The repository contains the platform, SDK, CLI and verification tools, not customer applications or demonstration frontends. The SDK/CLI is publicly published on npm; the platform is not yet a complete Convex replacement or fully production-certified.

## Deployment

- Landing: [flare.auer.wien](https://flare.auer.wien)
- Protected dashboard: [dash.flare.auer.wien](https://dash.flare.auer.wien)
- Runtime: `https://api.flare.auer.wien`

The application package is `@auersperg/flare`; its CLI binary remains `flare`. Existing projects, user IDs and data survive the rename. Internal SQLite `_flared_*` tables, session-token format and dynamic-runtime identity headers remain stable storage/protocol identifiers so retained releases and sessions keep working; they are not public product names.

## Product

- **Core:** shared Admin Worker + Astro/shadcn static dashboard, Runtime Worker, Dynamic Workers, supervisor Durable Objects and persistent SQLite `app` facets.
- **SDK:** queries, live subscriptions, mutations, actions, React hooks, generated browser-safe TypeScript references and OpenAPI 3.1.
- **CLI:** build/link/cloud-dev/deploy tooling and explicit account-authorized platform install/status/update/adopt. No local dashboard, backend emulator or Cloudflare administrative credentials in client bundles.

The dashboard is **Cloudflare-hosted only**, protected by Cloudflare Access, and not required for application traffic. D1 holds the administrative catalogue/audit only; application data lives in its environment facet. R2 stores immutable releases; Queues deliver transactional outbox jobs. Frontends deploy independently.

New projects start **empty**, with no demo tables, functions or records. Define their schema/functions in the application's own repository and deploy a release. Existing cloud projects are never reset by building or cleaning this repository.

## Repository

| Directory        | Purpose                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `packages/flare` | One application-facing package: SDK exports and CLI command                |
| `packages/core`  | Platform runtime, online dashboard, D1 migrations, empty project bootstrap |
| `tests`          | Regression tests and small test-only fixtures, never production seeds      |
| `scripts`        | Reproducible builds, packaging checks and explicit cloud acceptance        |
| `docs`           | Architecture, operations and remaining production gates                    |

One Bun workspace and lockfile. Installed dependencies, generated output and credentials are ignored. No `apps`/`examples` workspace or duplicated demo toolchain. The task fixture under tests is used only by explicit acceptance scripts; production builds do not consume it.

[Architecture](docs/architecture.md) · [Install and update](docs/platform-lifecycle.md) · [Production runbook](docs/production-runbook.md).

## Build and verify

Bun **1.4.3+** for development, CLI and builds. Node **24.11+** is required only by the vendor Wrangler tooling. Clone the public MIT-licensed repository:

```sh
git clone https://github.com/auersperg/flare.git
cd flare
bun install --frozen-lockfile --ignore-scripts
bun run verify
# Additional native kernel verification, local test-only workerd:
bun run test:kernel
# Remove generated output and temporary reports:
bun run clean
```

`verify` checks source types, unit tests, production bundles/CSP/bootstrap and real single-package tarball installation in a disposable external workspace. The package proof builds an ephemeral independent Astro/React frontend; no persistent demo is copied into the repository. Its workspace is removed on success or failure.

GitHub CI repeats verification, local native kernel checks and the production-dependency audit with Bun 1.4.3 on Linux (Node 24 for Wrangler only). The CI workflow needs no Cloudflare credentials, creates no cloud resources and does not deploy or publish packages. npm publishing uses the separate, manually approved `publish.yml` workflow. A green CI run is not full production acceptance.

Bun is the single local toolchain: `bun.lock`, native `bun test`, `Bun.build` for Worker/application bundles, `Bun.Transpiler` for portable SDK JavaScript, and `bun pm pack` for distribution checks. TypeScript still emits declarations; Astro keeps its supported Vite integration, executed under Bun. No parallel npm/Vitest/esbuild pipeline is maintained. SDK clients remain portable browser/server JavaScript; only the compiler/CLI require Bun. Worker bundles target Cloudflare, never Bun. Wrangler itself uses its supported Node runtime; a forced Bun Wrangler dev run hung during native acceptance, so this boundary is explicit rather than silently emulated.

`build` emits the self-contained `@auersperg/flare` package, internal SDK output, the two shared Workers, the static online dashboard and the empty bootstrap release. `clean` removes ignored builds, reports, caches and Finder metadata, not source, installed dependencies, operator credentials or cloud data. Run `build` again before packaging/deployment.

Dashboard: Astro 7.3.8, React 19.3.0, actual shadcn `bKGijeGe` preset (Base UI Lyra / Stone / Geist / Lucide). Secondary views are lazy-loaded; no SSR adapter, background polling or automatic live subscription. TypeScript 6.0.2 remains the supported Astro/Volar checker rather than forcing an unsupported compiler API.

## Application development

Customer code belongs in **a separate application**, not a platform workspace. The user-facing package is **`@auersperg/flare`**: client, server declarations and CLI in one installation. SDK/CLI live inside `packages/flare/src`, not separate source workspaces. The `@auersperg/flare` archive contains portable SDK JavaScript/types and a separate lazy-loaded Bun CLI; no `@flare/sdk` / `@flare/cli` archives, overrides or symlinks are required. React is an optional peer dependency. Browser imports cannot reach the CLI/compiler.

npm preview installation (`next` tag):

```sh
bun add @auersperg/flare@next
bunx --bun --package @auersperg/flare@next flare dev
```

With the npm package installed, `bunx --bun --package @auersperg/flare@next flare dev` already implements the same command interface:

1. On the first run, enter your installation's Runtime URL. Confirm the matching code in the Cloudflare Access-protected dashboard; select or create a project there.
2. The CLI stores a project-scoped, 30-day credential outside the application in `~/.config/flare`, mode 0600. No token is copied into source or frontend env. Settings can revoke it. A new sign-in is required after expiry/revocation.
3. Write a default-exported `defineSchema` document contract in `flare/schema.ts` and named query/mutation/action exports in `flare/*.ts`. Nested folders create nested function paths; helpers can use underscore-prefixed files.
4. `dev` automatically discovers functions, validates the document/index contract, compiles native bundles, publishes to cloud dev and writes `flare/_generated/api.ts`. Use `api.tasks.list` rather than a build-directory path. The public dev URL is written to `.env.local` using the framework prefix (Astro: `PUBLIC_FLARE_URL`, Expo: `EXPO_PUBLIC_FLARE_URL`, otherwise `VITE_FLARE_URL`), preserving other variables. The watch is restricted to backend source; frontend edits do not deploy the backend.
5. Run the frontend with its framework's normal dev server. Configure allowed frontend origins and application-user authentication separately; CLI sign-in is deployment authorization, not a user login.

```text
my-app/
├── src/                   # Astro / React / Expo frontend
└── flare/
    ├── schema.ts          # defineSchema({tasks:defineTable(z.object(...))})
    ├── tasks.ts           # export const list = query(...)
    └── _generated/        # typed server declarations and browser API; ignored
```

```ts
// flare/tasks.ts
import { z } from "@auersperg/flare/server";
import { query } from "./_generated/server";
export const hello = query({
  input: z.object({}),
  output: z.string(),
  handler: () => "Hello from Flare",
});
```

```sh
bunx --bun --package @auersperg/flare@next flare deploy
```

This builds and deploys to **production**, with an explicit confirmation naming the project. CI uses a linked project plus `FLARE_DEPLOY_TOKEN` and `--confirm <UUID>`. Advanced build/link/custom-entry commands remain available for explicit build pipelines, but are not the normal application flow.

A fresh platform installation includes administrative migration `0003_cli_login.sql`, `DASHBOARD_URL` and the updated Admin Worker/dashboard. The browser login is protected by Access, owner authorization and same-origin CSRF checks; login sessions expire after ten minutes. Credential delivery is encrypted to the CLI's ephemeral RSA key and claimed only once with its secret. No local dashboard or callback HTTP server is started.

Schema changes validate existing documents and update native SQLite expression indexes in one transaction. Missing required fields, invalid records and removal of a nonempty table reject activation. Optional/defaulted fields are supported; no SQL journal or ORM migration generator is needed. Data transformations are explicit application mutations; code rollback is not database rollback.

**Breaking change:** only runtime ABI 4 and the native document API are supported. Old `tables`, Drizzle SQL declarations, `--migrations` and ABI 1–3 have been removed. Use a fresh environment/installation for this preview; rebuilding does not reset the existing cloud deployment, catalogue or databases. Do not deploy 0.3 over a 0.2 installation assuming compatibility.

Published 0.3.7 includes `flare platform install|status|update|adopt` and a checksummed platform payload in the same npm archive. This remains a trusted-team preview, not accepted on a separate Cloudflare account. As of October 13, 2026, `next` is 0.3.7 and the personal panel has passed the ordinary published-CLI update from 0.3.6; `latest` remains 0.3.1. Pin exact versions for repeatable installation. See [platform lifecycle](docs/platform-lifecycle.md) for prerequisites, confirmation, recovery and update limits. `init` / `db generate` remain unnecessary for applications. Core/dashboard remain private workspaces, not separate npm packages. Local builds perform no cloud deployment.

## Native data API

```ts
// flare/schema.ts
import { defineSchema, defineTable, z } from "@auersperg/flare/server";
export default defineSchema({
  tasks: defineTable(
    z.object({
      title: z.string().min(1),
      done: z.boolean().default(false),
    }),
  ).index("by_done", ["done"]),
});
```

```ts
// flare/tasks.ts
import { z } from "@auersperg/flare/server";
import { query, mutation } from "./_generated/server";
export const list = query({
  auth: "public",
  input: z.object({}),
  output: z.array(
    z.object({
      _id: z.string(),
      _creationTime: z.number(),
      title: z.string(),
      done: z.boolean(),
    }),
  ),
  handler: ({ db }) =>
    db
      .query("tasks")
      .withIndex("by_done", (q) => q.eq("done", false))
      .take(100),
});
export const create = mutation({
  auth: "public",
  input: z.object({ title: z.string().min(1) }),
  output: z.string(),
  handler: ({ db }, args) => db.insert("tasks", args),
});
```

### One query, one reactive call

The only server function kinds are **query**, **mutation** and **action**. Every public query can be read once or subscribed to; there is no `live` declaration, duplicate `watch` function or compatibility alias.

```ts
import { createClient } from "@auersperg/flare";
import { api } from "./flare/_generated/api";
const client = createClient({ url: REACTIVE_URL, getToken });
// Choose one mode; no initial fetch is required before onUpdate.
const stop = client.onUpdate(api.tasks.list, {}, (tasks) => render(tasks));
// Alternatively: const tasks = await client.query(api.tasks.list, {});
await client.mutation(api.tasks.create, { title: "New task" });
// On teardown: stop(); client.dispose();
```

```tsx
import { FlareProvider, useQuery } from "@auersperg/flare/react";
function Tasks() {
  const tasks = useQuery(api.tasks.list, {});
  if (tasks === undefined) return <p>Loading…</p>;
  return (
    <ul>
      {tasks.map((task) => (
        <li key={task._id}>{task.title}</li>
      ))}
    </ul>
  );
}
// At the app root: <FlareProvider client={client}><Tasks /></FlareProvider>
```

`useQuery` returns the data, unsubscribes on unmount, supports `"skip"`, and throws function/auth errors to an error boundary. Reconnecting keeps the last snapshot. No client, WebSocket or polling is created by server rendering. The provider receives a client owned by your app. One-off `query` uses HTTP; `onUpdate` uses a shared hibernating WebSocket, whose initial snapshot is the first result. A ticket request authenticates that connection — it is not a second query. Identical active subscriptions share transport/work; inactive queries do not run in the background. Dashboard execution is a one-off call and never opens a subscription automatically.

Every logical table is a native SQLite table of validated JSON documents with `_id` and `_creationTime`. Declared scalar indexes are native SQLite expression indexes; pagination is keyset, not JavaScript filtering of a whole collection. Queries have no raw SQL or write capability. Mutations and dashboard edits use the same validators, transaction and revision/outbox path. Live tracks affected tables conservatively, including crash recovery; this is not a full Convex read-set engine. See [architecture](docs/architecture.md) for limits, storage trade-offs and optional capabilities.

## Dashboard

Eight primary sections: **Health, Data, Schema, Functions, Files, Schedules, Auth, Logs**. Project/environment selection is in the header; Settings is under the gear, SDK setup under Health.

- Real paginated data, typed add/edit forms, explicit NULL/defaults, revision checks, immutable primary keys, audit and production confirmation.
- Schema is defined in application code; the panel displays its active contract. Data editing remains available.
- Shared yellow query / blue mutation / purple action badges; typed arguments, tabular results. Function execution is explicit, dev-only, not for viewers or internal functions.
- Actual invocation summaries and job receipts, not simulated Tail/billing analytics. Files use private R2 with upload/download/delete; Schedules shows delayed outbox jobs, delivery attempts and native cron jobs. Refresh is on demand, never polling.
- Owner/editor/viewer checks, verified Access identity, same-origin CSRF protections and strict build-generated CSP.

Administrative views currently use snapshots, updated after their own writes and on focus/visibility return, without interval polling. Cross-client SDK changes do not yet push updates to every open dashboard view. K2 streams are discussed as a future event capability, not installed or exposed by the current SDK.

## Operations and boundaries

Use the [platform lifecycle](docs/platform-lifecycle.md) for first install, explicit adoption of the supported legacy layout, status and updates. Account credentials stay outside application code. The CLI provisions the mutual Admin/Runtime service bindings, applies additive migrations and preserves existing resources, namespaces, secrets and Access policy during updates.

For a managed installation, choose an exact compatible CLI release and run:

```sh
flare platform status --account ACCOUNT_ID
flare platform update --account ACCOUNT_ID --dry-run
flare platform update --account ACCOUNT_ID
```

The target is bundled with that CLI, not a moving tag. Do not deploy Admin/Runtime directly with Wrangler after adoption: it bypasses the D1 lease and makes the next update refuse configuration drift. `bun run update:platform` is the source-checkout shortcut and requires a prior build. The retired setup script and direct-deploy configuration examples are removed. The lifecycle CLI is the only supported platform installation/update path. Landing/frontend hosting remains independent.

Commit only the configuration examples, never live installation files. `tests/kernel/wrangler.json` has no account ID and is for local native testing. For remote kernel testing, create a separate ignored `tests/kernel/wrangler.cloud.json` for disposable resources and explicitly select it when deploying. `scripts/set-kernel-secret.mjs` requires `FLARE_KERNEL_CONFIG`; acceptance scripts require `FLARE_KERNEL_URL`. `.private` retains installation checkpoints and test/signing credentials, never packaged or committed.

Explicit cloud acceptance commands can create test resources/projects and write test data. They are not part of `verify`, and must not target customer production data. Production builds/cleanup perform no cloud operations.

Dynamic Workers/Facets/Lifecycle depend on beta/experimental Cloudflare APIs. Supported scope is trusted applications/team members, not public untrusted multi-tenancy. Native scoped Secrets Store reads and a restricted action `globalOutbound` gateway are implemented but need operator bindings/policy and real-cloud acceptance. Dashboard secret provisioning, full analytics, unrestricted export/disaster recovery, complete release draining, independent-account installer acceptance and client-specific delegated membership remain unfinished. Protected functions accept enabled built-in password sessions or configured OIDC identities; application handlers enforce record permissions. Queues are at-least-once; ambiguous mutations are not automatically retried.

No guarantee that $5 covers total usage or that Flare is cheaper/faster than Convex for every workload. The SDK/CLI package `@auersperg/flare` is MIT-licensed. The entire repository, including core and dashboard, is MIT-licensed. npm publication is a separate explicit release step.

## Release status

Use 0.3 for a controlled, trusted-team installation only. Before treating it as a general production backend, complete the limitations in the [runbook](docs/production-runbook.md): independent installation/optional external OIDC, release draining, workload-specific load/cost tests, extended disaster recovery and the unfinished service capabilities. No runtime architecture was replaced just to make repository checks pass.

## Backups

Settings → Backups and the CLI create private R2 capsules containing documents,
ready files and the exact backend release. Restore requires owner confirmation and
an empty other environment of the same project. It is not in-place rollback or
PITR. Limits and exclusions are in the
[production runbook](docs/production-runbook.md).

Current verification commands and production gates are documented in the
[production runbook](docs/production-runbook.md) and
[production runbook](docs/production-runbook.md). Test reports are generated locally,
ignored by Git and removed by `bun run clean`; historical test counts and project
names are not a description of an operator's current installation.

## Release history and promotion

Health → Deployment history (collapsed by default) shows the last five distinct successful backend builds and their contracts. `bunx --bun --package @auersperg/flare@next flare promote --env prod --hash HASH` activates the exact tested dev bundle, without rebuilding or copying dev data. Compatible code rollback uses `bunx --bun --package @auersperg/flare@next flare rollback --env prod --hash HASH`; the database is not rewound. Both require confirmation and reject a concurrently changed target.

`bunx --bun --package @auersperg/flare@next flare deploy --cmd "bun run build"` builds frontend references/URL before backend activation. An application-owned script can then publish frontend assets with native Wrangler. This is sequential, not atomic: a final hosting failure is an explicit partial release. Historical isolated previews and paired frontend/backend version history are not yet implemented. See [CLI release flow](packages/flare/README.md#immutable-releases) and [operational boundaries](docs/production-runbook.md).

Operator checklist: [production runbook](docs/production-runbook.md). Short acceptance does not certify a monthly bill or an unperformed load test.

## Root layout

The root keeps only `package.json`, `bun.lock`, `tsconfig.json`, `README.md`, `LICENSE`,
`.gitignore` and `.prettierignore`. Formatting settings live in `package.json`.
Platform configurations are generated by the lifecycle CLI from its verified payload. Do not copy or maintain an independent Admin/Runtime deployment configuration. Existing private recovery artifacts stay ignored and are never shipped.
