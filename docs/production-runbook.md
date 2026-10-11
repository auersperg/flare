# Production runbook: trusted-team installation

Flared is a self-hosted backend, not a managed service with an operator SLA. Use the shared Cloudflare installation for trusted application code. Dev and prod have independent data, accounts, files and schedules. Promotion copies a backend release, not those resources.

## Before admitting real users

1. Complete local verification (`bun run verify`, `bun run test:kernel`, production dependency audit).
2. Explicitly deploy the tested Core builds and apply catalog migrations. Record both Worker version IDs and the application release hash.
3. Run short cloud acceptance on disposable scopes. Reports must say PASS **and** resourcesCleaned. A cancelled load test is not a passed soak test.
4. Configure each application's origin allowlist and password-auth settings. Keep registration disabled unless needed. Password auth does not enforce record ownership: handlers must derive ownership from ctx.auth, never a user ID supplied by the client. Verify two distinct users cannot read or modify each other's records, including subscriptions.
5. Make schema changes compatible with old clients. Test the frontend build against the chosen production URL before promotion. Backend/frontend publishing is sequential, not atomic; inspect both results.
6. Choose an acceptable recovery point/time and verify that the bounded empty-target restore meets it. Do not admit irreplaceable data if same-account R2 and empty-target-only recovery are insufficient.

The cloud scripts require the existing operator installation and Wrangler session. They create only random disposable scopes; they never reset Local/test. Temporary proof Workers have a random secret, fixed compiled-in scopes and are removed after the proof. They are not part of the production architecture or SDK.

## Backup and restore

- Before a risky change: pause cron, drain pending/running/failed jobs and actions, finish uploads. Inspect the selected environment, then create an on-demand logical backup in Settings → Backups or `flared backup create --env prod`.
- Record backup ID, source release hash, creation time, document/file counts and completion. Incomplete capsules cannot be used for restore. Verify recovery on an empty other environment before relying on it.
- Current bounds: 10,000 documents / 4 MiB logical data; 100 files / 100 MiB. Password hashes are private credential data. Sessions, secrets, auth/origin configuration, cron and historical jobs are not copied.
- Restore only into the other **empty** environment of the same project. Select source and backup ID explicitly. A failed restore remains fenced; retry the same capsule after repairing the cause. Do not clear fences/pins or overwrite a populated prod environment.
- Verify document IDs/counts, file bytes, release hash and login/record permissions. Configure target capabilities/auth explicitly, then reopen traffic.
- Delete obsolete backups explicitly after a newer restore is verified. No retention daemon or automatic periodic backup is configured. R2 storage remains billable while idle.

## Jobs, errors and recovery

- Schedules shows bounded job state; Logs shows recent application summaries, not complete Cloudflare telemetry. Health being ready is not proof that all jobs succeeded.
- Investigate failed jobs and the native `flared-jobs` dead-letter queue. Keep the payload, job ID, environment and referenced release available. External effects are at-least-once: reconcile using the application's idempotency key before retrying.
- Automatic DLQ redrive is not implemented. Never blindly replay a message with an unknown external outcome or silently discard messages. Fix the handler, confirm the retained release/contract, and perform explicit application-level reconciliation.
- On ambiguous mutation failure, read current state before retrying. The SDK deliberately does not retry writes automatically.
- On a deployment conflict, wait for admitted actions/jobs to finish; retry with the expected active hash. Code rollback does not undo data or external effects.
- Project deletion requires the owner and exact project name; it deletes dev **and** prod. Partial failure stays fenced for a repeat attempt. Shared queues, unrelated projects and account Access settings are not removed.

## Usage and idle cost

Use Cloudflare's account billing/usage for the actual subscription period, then scope analytics to flared-admin/flared-runtime and their DOs. Record the time window and sampling; do not call an account-wide counter Flared-only usage.

Track Workers requests/CPU, DO requests/duration, SQLite reads/writes/storage, D1 rows, Dynamic Worker daily creation units, R2 storage/operations, Queue operations and Logs events. Immutable loader IDs do not create a runtime per request. Hibernating sockets avoid continuous execution, but storage, active work and scheduled jobs are still billable.

No always-on monitoring process, periodic dashboard poll, backup timer or synthetic production heartbeat is added. Native Cloudflare notifications/budget thresholds must be configured and verified by the operator; this runbook does not imply they are enabled. The $5 plan is a minimum, not a spending cap. Estimate a month from representative application traffic, separately from test workloads.

## Release decision

A passed short acceptance supports a controlled pilot, not an unlimited production guarantee. Current exclusions: off-account disaster recovery/PITR, arbitrary tenant dashboard delegation, automatic DLQ replay, comprehensive telemetry/alerts, independent account installation, full-stack atomic publishing and arbitrary external identity-provider acceptance. Experimental native API compatibility also remains an operator risk.

Do not label a cancelled 30-minute test as complete. Preserve exact reports, failing checks and cleanup outcome locally; private credentials and raw authenticated request logs never belong in Git.

## Acceptance checkpoint — 2026-10-11

Latest short Cloudflare proof: 16 platform checks, eight backup/auth/release checks and two grouped deletion checks passed. The deletion proof calls the production deletion module through a secret-protected, fixed-scope operator Worker; it is not an end-to-end test of Cloudflare Access login. Both environments, credentials and scoped R2 objects are checked; URL reservations remain until the disposable proof is explicitly cleaned. All proof resources were cleaned. Local verification: 325 tests, packaged installation/build checks, native workerd kernel and production dependency audit passed.

Two independently registered password users exercise indexed ownership queries, cross-user mutation refusal and isolated live results. SDK errors from separately bundled entrypoints now retain their bounded explicit codes instead of depending on class identity; ordinary error messages remain private. Existing application bundles must be rebuilt to take this SDK correction—deploying Core alone does not rewrite an immutable application release.

The 30-minute test was stopped at the owner's request, with its temporary scopes cleaned. No current soak/throughput/monthly-price certification is claimed. Local and test application data were not reset. Reports stay under ignored artifacts; repository documentation contains conclusions, never credentials or raw authenticated traffic.

## Production endpoint policy

The AUER installation exposes Flared only through `https://api.auer.wien` and the Access-protected `https://dashboard.auer.wien`. Native `workers.dev` and version preview URLs are disabled for both Workers. The operator's ignored Wrangler configurations persist `workers_dev: false`, `preview_urls: false` and explicit custom-domain routes so a future deployment does not restore the alternate endpoints. Internal service bindings and native RPC do not require public workers.dev URLs.

The obsolete cloud kernel (Worker, DO class/namespace, R2 bucket, jobs/DLQ) and test frontend/project have been retired. Cloud acceptance can provision disposable resources explicitly; it is not permanently deployed or running in production. Keep the two shared Workers, catalog, two private R2 buckets and jobs/DLQ. Audit, permanent URL reservations and small deletion tombstones are intentional safety records, not active test applications. Other websites and their Cloudflare resources are outside Flared cleanup scope.
