# Flared platform 0.2 private minimum

Shared Cloudflare Admin + Static Assets and Runtime Workers, deployed once per installation, not per application. Online-only dashboard, native Worker Access, D1 administrative catalogue/audit, Dynamic Workers, supervisor Durable Objects and stable SQLite `app` facets, R2 releases, hibernating live subscriptions and Queues consumer.

Source entrypoints: `src/admin.ts`, `src/runtime.ts`. Dashboard: `dashboard/`. Native kernel acceptance fixtures live in workspace `tests/kernel/`, outside this package. Current installation configurations belong to the operator's account; portability and the public one-command installer remain unfinished.

Applications use the SDK, their own environment URL and user identity. The CLI's project credential goes only to the management API. Core/dashboard/Cloudflare capability dependencies must not enter browser or thin CLI bundles.

Files, Secrets Store, controlled external action egress, full analytics and export/restore are not implemented. See the workspace README for working features, tests and production limitations. Private local package, unpublished, UNLICENSED.
