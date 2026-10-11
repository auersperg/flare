# Flare platform 0.3 — native-data preview

Shared Admin + Static Assets and Runtime Workers in the operator's own Cloudflare account, not Workers per application. Online-only Astro/shadcn dashboard, Access, D1 control catalogue/audit, Dynamic Workers, supervisor Durable Objects, persistent native SQLite `app` facets, hibernating live, R2 and Queues/Scheduler.

Application data uses validated documents and native SQLite expression indexes. Queries have no SQL/write capability; mutations, admin edits, revisions and jobs share a transactional path. No ORM, app SQL journal or legacy runtime ABI remains. Only ABI 4 is accepted; use a fresh environment/installation, not an assumed in-place 0.2 upgrade.

Files stream through private R2 grants. Actions use narrow environment capabilities, optional operator-controlled `globalOutbound`, and native Secrets Store bindings. These optional capabilities require provisioning and real-cloud acceptance; no account credential is given to application code. Bounded logical backup/restore to an empty other environment is implemented and cloud-tested. Full analytics, unrestricted/off-account disaster recovery, delegated customer membership and a portable one-command installer remain unfinished.

Native core/SDK integration runs against local workerd as part of `test:kernel`; Cloud acceptance on 11 October confirmed physical hibernation/resumption, data/live/upgrade/Queues and 1002-record pagination. A separate 30-minute / 100-client cloud soak passed; workload-specific billable usage still needs measurement. Activation crash checkpoints are verified locally and are not presented as cloud crash proof. Local build/test do not change deployed Workers, SQL data, Access, DNS or billing. Source entrypoints: `src/admin.ts`, `src/runtime.ts`. Dashboard: `dashboard/`. Test fixtures stay outside the production package.

MIT-licensed, not published to npm. See the root README and architecture maps for the current contract, resource policy and remaining gates.
