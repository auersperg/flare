# flared

One application package: portable JavaScript SDK, schema/function declarations, optional React hooks and Bun development/deployment CLI. Internal SDK/CLI packages are not application dependencies.

```sh
bun add flared
bunx flared dev
```

These are the target registry commands; the package is currently private/unpublished and installed from a verified tarball. Approve the CLI in your online dashboard, select/create a project, define `flared/schema.ts` and functions, then run `bunx flared deploy` when ready.

0.3 uses native Cloudflare SQLite documents/indexes; no ORM or app SQL migration journal. `_generated/server` provides schema-typed server declarations and `_generated/api` browser-safe references. Core is deployed separately into your own Cloudflare account. There is no local dashboard.

Private, UNLICENSED. Legacy SQL/Drizzle releases are intentionally unsupported; no cloud data is automatically erased by the upgrade or local build.
