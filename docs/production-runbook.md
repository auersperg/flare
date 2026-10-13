# Production runbook: trusted-team installation

Current 0.3.7 managed installs use [platform lifecycle](platform-lifecycle.md). Disposable install/recovery/cleanup have been exercised in the owner's account; the real 0.3.3 → 0.3.4 update preserved data/auth/files/pending jobs and owner Access sign-in was checked separately in the browser. Independent-account fresh-install acceptance remains pending; standard-layout adoption was exercised on the existing personal panel with the external compiled 0.3.5 CLI, and the exact 0.3.4 → candidate 0.3.5 cloud update passed separately. Historical operator recovery guidance remains below; an adopted installation must use the lifecycle CLI, not direct Worker deploys.

Flare is a self-hosted backend, not a managed service with an operator SLA. Use the shared Cloudflare installation for trusted application code. Dev and prod have independent data, accounts, files and schedules. Promotion copies a backend release, not those resources.

Personal installation: published 0.3.7 update and owner Access sign-in verified on October 13, 2026; four completed pre-update capsules retained. The declared fixture load/recovery/alert checks are documented in the [improvement plan](production-runbook.md), not a general SLA.

## Before admitting real users

1. Complete local verification (`bun run verify`, `bun run test:kernel`, production dependency audit).
2. Use the exact accepted CLI version: `platform status`, `platform update --dry-run`, then the confirmed managed update. The lifecycle applies catalog migrations and preserves resource identities. Do not directly deploy Core Workers over a managed installation. Record both Worker version IDs and the application release hash.
3. Run short cloud acceptance on disposable scopes. Reports must say PASS **and** resourcesCleaned. A cancelled load test is not a passed soak test.
4. Configure each application's origin allowlist and password-auth settings. Keep registration disabled unless needed. Password auth does not enforce record ownership: handlers must derive ownership from ctx.auth, never a user ID supplied by the client. Verify two distinct users cannot read or modify each other's records, including subscriptions.
5. Make schema changes compatible with old clients. Test the frontend build against the chosen production URL before promotion. Backend/frontend publishing is sequential, not atomic; inspect both results.
6. Choose an acceptable recovery point/time and verify that the bounded empty-target restore meets it. Do not admit irreplaceable data if same-account R2 and empty-target-only recovery are insufficient.

The cloud scripts require the existing operator installation and Wrangler session. They create only random disposable scopes; they never reset retained application projects. Temporary proof Workers have a random secret, fixed compiled-in scopes and are removed after the proof. They are not part of the production architecture or SDK.

## Backup and restore

- Accepted personal-project policy: RPO at most 24 hours, RTO at most one hour. This is an operator objective, not an automatic service guarantee; acceptance requires a completed restore rehearsal for the selected workload.
- The owner operates a daily backup cadence and a backup before risky changes. Check that the newest **completed** capsule is less than 24 hours old; a scheduled intention or an incomplete capsule does not satisfy RPO. Keep recovery metadata privately, and explicitly remove old capsules only after checking a newer recovery point. No automatic backup or retention timer is installed.
- Before a risky change: pause cron, drain pending/running/failed jobs and actions, finish uploads. Inspect the selected environment, then create an on-demand logical backup in Settings → Backups or `flare backup create --env prod`.
- Record backup ID, source release hash, creation time, document/file counts and completion. Incomplete capsules cannot be used for restore. Verify recovery on an empty other environment before relying on it.
- Current bounds: 10,000 documents / 4 MiB logical data; 100 files / 100 MiB. Password hashes are private credential data. Sessions, secrets, auth/origin configuration, cron and historical jobs are not copied.
- Restore only into the other **empty** environment of the same project. Select source and backup ID explicitly. A failed restore remains fenced; retry the same capsule after repairing the cause. Do not clear fences/pins or overwrite a populated prod environment.
- Verify document IDs/counts, file bytes, release hash and login/record permissions. Configure target capabilities/auth explicitly, then reopen traffic.
- Delete obsolete backups explicitly after a newer restore is verified. No retention daemon or automatic periodic backup is configured. R2 storage remains billable while idle.

## Jobs, errors and recovery

- Schedules shows bounded job state; Logs shows recent application summaries, not complete Cloudflare telemetry. Health being ready is not proof that all jobs succeeded.
- Investigate failed jobs and the native `flare-jobs` dead-letter queue. Keep the payload, job ID, environment and referenced release available. External effects are at-least-once: reconcile using the application's idempotency key before retrying.
- Automatic DLQ redrive is not implemented. Never blindly replay a message with an unknown external outcome or silently discard messages. Fix the handler, confirm the retained release/contract, and perform explicit application-level reconciliation.
- DLQ triage belongs to the installation owner: identify project/environment, job ID, release, due time and attempt history; compare the application's idempotency record and any downstream effect before replay. If the outcome is unknown, reconcile it first. Preserve the message and retained release until the case is resolved; never replay against another environment or normalize the payload to bypass validation.
- On ambiguous mutation failure, read current state before retrying. The SDK deliberately does not retry writes automatically.
- On a deployment conflict, wait for admitted actions/jobs to finish; retry with the expected active hash. Code rollback does not undo data or external effects.
- Project deletion requires the owner and exact project name; it deletes dev **and** prod. Partial failure stays fenced for a repeat attempt. Shared queues, unrelated projects and account Access settings are not removed.

## Usage and idle cost

Use Cloudflare's account billing/usage for the actual subscription period, then scope analytics to flare-admin/flare-runtime and their DOs. Record the time window and sampling; do not call an account-wide counter Flare-only usage.

Track Workers requests/CPU, DO requests/duration, SQLite reads/writes/storage, D1 rows, Dynamic Worker daily creation units, R2 storage/operations, Queue operations and Logs events. Immutable loader IDs do not create a runtime per request. Hibernating sockets avoid continuous execution, but storage, active work and scheduled jobs are still billable.

No always-on monitoring process, periodic dashboard poll, backup timer or synthetic production heartbeat is added. Native Cloudflare rules are enabled for the owner:

- Account-wide $10 usage-charge alert; Cloudflare accepted the test dispatch and the owner confirmed email receipt. This is not a Flare-only metric or a spending cap.
- `Flare — Worker errors`: count native `logs.issues` occurrences for exactly `flare-admin` and `flare-runtime`, threshold ≥1, automatic one-minute window/evaluation, repeat at most hourly.
- `Flare — jobs dead-lettered`: count `events.queuesMessages` operations for the personal `flare-jobs` queue with `outcome = 'dlq'`, with the same threshold/evaluation/repeat settings. This is sampled native telemetry for new dead-letter transitions, **not** a continuous DLQ backlog gauge or a guarantee to observe every event. Inspect the queue during incident triage even when no email has fired.

Worker/DLQ rule configuration was read back, both test dispatches accepted by Cloudflare, and the owner confirmed receipt of both emails. Real fault-to-rule triggering was not tested against the personal panel; test dispatch does not certify metric coverage. Existing account policies were not modified. The $5 plan is not a spending cap. Estimate a month from representative application traffic, separately from test workloads. [Native Custom Alerts](https://developers.cloudflare.com/notifications/notification-available/) run inside Cloudflare; their scheduled metric evaluation is not application data polling.

## Account credential renewal

The current scoped platform token expires on 11 November 2026 at 22:59:59 UTC. Renew it before expiry with the same required account/zone scope, save the replacement only in the private local credential file (mode `0600`), and verify `platform status` before deleting the previous token. Do not add permissions for unrelated products. Expiry blocks administrative CLI requests, not execution of already deployed Workers, application sessions or service bindings. Tokens, signing keys and raw authenticated logs must not be committed or included in public reports.

## Release decision

A passed short acceptance supports a controlled pilot, not an unlimited production guarantee. Current exclusions: off-account disaster recovery/PITR, arbitrary tenant dashboard delegation, automatic DLQ replay, comprehensive telemetry/alerts, independent account installation, full-stack atomic publishing and arbitrary external identity-provider acceptance. Experimental native API compatibility also remains an operator risk.

Do not label a cancelled 30-minute test as complete. Preserve exact reports, failing checks and cleanup outcome locally; private credentials and raw authenticated request logs never belong in Git.

## Release evidence

Record the source revision, dependency/toolchain versions, commands, result, target release hash and cleanup outcome for each acceptance run. Local checks do not certify Cloudflare Access login, physical cloud hibernation or billing. The secret-protected deletion harness verifies the production deletion module, not an end-to-end dashboard login. Historical reports are not a substitute for testing the selected release.

Two independently registered users must exercise ownership queries, cross-user mutation refusal and isolated live results. SDK changes require rebuilding and deploying app bundles; deploying Core alone does not rewrite immutable application code. A previously cancelled soak remains unperformed, not PASS. Raw authenticated logs and credentials stay private.

## Production endpoint policy

The AUER installation exposes Flare only through `https://api.flare.auer.wien` and the Access-protected `https://dash.flare.auer.wien`. Native `workers.dev` and version preview URLs are disabled for both Workers. The operator's ignored Wrangler configurations persist `workers_dev: false`, `preview_urls: false` and explicit custom-domain routes so a future deployment does not restore the alternate endpoints. Internal service bindings and native RPC do not require public workers.dev URLs.

The obsolete cloud kernel (Worker, DO class/namespace, R2 bucket, jobs/DLQ) and test frontend/project have been retired. Cloud acceptance can provision disposable resources explicitly; it is not permanently deployed or running in production. Keep the two shared Workers, catalog, two private R2 buckets and jobs/DLQ. Audit, permanent URL reservations and small deletion tombstones are intentional safety records, not active test applications. Other websites and their Cloudflare resources are outside Flare cleanup scope.
