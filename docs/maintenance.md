# Maintenance

## Production-focused source tree

Internal product packages: Core, SDK, CLI. The user-facing `flared` package exposes SDK entrypoints and the CLI in one installation. Core contains the online Astro/shadcn dashboard and an empty application bootstrap used when creating projects. No demonstration frontend, hard-coded developer-session endpoint or application workspace belongs in the production repository.

Task/counter fixtures exist only under tests or in disposable acceptance workspaces. Normal platform builds must never compile them, seed their tables/functions or depend on their directories. Existing cloud projects keep their releases/data; an empty bootstrap applies only to newly created projects after deploying the updated Admin.

Customer frontend/backend source belongs in separate application repositories. The single application-facing flared package installs there independently of Core/dashboard. There is no local dashboard mode or platform-owned frontend development server.

## Build and dependency boundaries

- One Bun workspace and lockfile; SDK/CLI 0.3.1, shared Admin/Runtime, Astro 7.3.8 and actual shadcn 4.21.4 preset `bKGijeGe`.
- Preset: Base UI Lyra / Stone / Geist / Lucide / subtle menu accent. Use checked-in components.json; don't add custom button/badge geometry.
- Native runtime dependencies remain pinned (Agents 0.28.0, Wrangler 4.149.0). UI maintenance does not add Cloudflare services or replace Dynamic Workers/Facets with per-project Workers.
- TypeScript 6.0.2 is supported by Astro/Volar's compiler API; don't force TypeScript 7 peers. Native Vite prerender resolution keeps the React virtual-module consumer and Astro cookie version bundled.
- Astro-generated bootstrap hashes feed Admin's strict CSP; no unsafe-inline/eval. Public hashed UI assets use asset-first immutable caching; HTML/API/bootstrap/starter remain protected and worker-first.
- Lazy secondary views, cancelled requests and scope-keyed remounting prevent stale data. Dashboard has no polling/automatic subscription/token issuance. Data uses a bounded full-height scroll region with a sticky header and bottom pagination. Files refresh once after an upload attempt and distinguish pending transfer from queue jobs. Function clients dispose on navigation.
- Add/Edit table prepares document schema drafts, never arbitrary live SQL or destructive schema edits. App schema, function contracts and release checksums stay versioned together.
- CLI scratch directories clean up in finally after success/failure. Immutable release output cannot be overwritten.

## Project deletion

Project settings → Delete project is available only to the installation owner through the Access-protected dashboard. Confirm the exact project name; the API also checks the immutable project ID. Editors, viewers and project-scoped CLI credentials cannot delete projects. Deletion always includes **both dev and prod**, not just the selected environment.

The D1 deletion barrier and deployment-credential revocation precede cleanup. Both supervisors' serial gates are durably fenced before any file/backup removal, so an admitted cross-environment restore finishes first. Supervisors close live connections, remove app facets/SQLite, alarms, files, releases and backups under their exact environment prefixes, and retain a tiny tombstone. Stale queue deliveries are acknowledged without executing; shared Queues are not deleted or purged. In-flight actions/jobs cause a retryable conflict. Abandoned backup pins within the deleted project are removed after both participants are fenced; standalone environment destruction still respects pins. Partial failures keep the project visible for another Delete attempt; cleanup is idempotent. The final catalog batch removes environments, credentials and the project.

Audit, immutable project-ID/short-URL reservations and customer workspaces remain. Old URLs never become another customer's project. Cloudflare Logs follow their account retention; manually provisioned Secrets Store bindings remain operator-managed. Apply `0005_project_deletion.sql` before deploying the new Admin/Runtime. No background cleanup daemon, extra bucket or per-project Worker is introduced.

## Verification

`bun run verify`: source checks, unit tests, production build verification and independent tarball package acceptance. The latter compiles both data-bearing test apps and an empty app, checks generated references/OpenAPI and builds an ephemeral Astro/React frontend with the packed SDK. Its external workspace is removed in finally.

`bun run test:kernel`: local workerd native kernel proof, separate from installed CLI dependencies and production bundles. `test:cloud-kernel`, `test:cloud-sdk` and `test:platform:cloud` are explicit operator workflows that may create cloud test resources/data; they do not run as part of verify.

Pre-0.3 Cloudflare acceptance reports are historical evidence for the old implementation, not acceptance of the breaking native document API. Current reports are produced by `verify`, `test:kernel` and the native core integration harness. The latter exercises actual Runtime/Facet/SDK code against local workerd, including live invalidation, shared document validation, failed/unawaited jobs, Queues, R2 and schema activation; it is not physical cloud hibernation or billing evidence.

`verify-build` is self-contained local bundle verification. It does not depend on historical acceptance reports, removed demos or an already logged-in cloud account. Never turn old load-test evidence into a current latency/cost guarantee.

Production dependency audit is separate from build tooling. Full development audit still reports [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) in the shadcn CLI registry → braces 3.0.3; no patched release is available. Production dependency audit passes; do not force a downgrade or unverified replacement. Those registry tools are not shipped to the browser/Workers.

## Generated and private files

`bun run clean` removes SDK/Core build output, Astro/Wrangler caches, CLI scratch state, test reports/tarballs and Finder metadata. Build again before packaging or deployment. Installed node_modules and the lockfile are not temporary project code.

`.private` contains active operator installation/signing/test credentials. Never commit or package it; cleanup preserves it. Do not put deploy credentials in a frontend bundle. Unneeded old demos, generated files and obsolete proof archives are removed; no parallel legacy source tree is retained.

Cleaning local files makes no Cloudflare request and does not remove customer projects, releases, SQLite data, DNS or Access policy. Keep Admin/Runtime installation configuration locally; Git tracks only `*.wrangler.example.json`. Local kernel configuration lives under tests/kernel, has no account ID and is test-only. An existing remote kernel uses a separate ignored `wrangler.cloud.json`; it is never selected implicitly by the secret helper.

## Repository workflow

Canonical repository: `auersperg/flared`, private, default branch `main`, UNLICENSED. All packages remain private to prevent accidental npm publication. Git excludes credentials, live account configuration, generated files and installed dependencies.

Keep changes small and reviewable. Run `bun run verify` and `bun run test:kernel` before merging. Browser CLI login requires Admin migration 0003 and DASHBOARD_URL; it does not bypass Access or mint frontend user tokens. Application schema/functions must be committed; `_generated` and `.flared` stay ignored.

GitHub CI runs these checks and the production-dependency audit with read-only repository permissions and pinned actions; it has no Cloudflare credentials or deployment job. Cloud acceptance/deployment remains explicit operator work, not a push side effect.

Record changes to app contracts, migration semantics, auth boundaries and beta API compatibility in the architecture documentation. Never include credentials or authenticated callback URLs in an issue, commit or log. Dependency audit and local regression coverage are not a complete security assessment or production certification.

## Remaining production gates

Repository cleanup is not full production certification. Required gates depend on the application: representative workload/cost acceptance, an acceptable recovery policy, release draining under concurrent actions, and operational error/DLQ ownership. Native password auth is supported; an independent external OIDC provider is optional, not mandatory for password-only applications. Operator Secrets Store/egress provisioning, full analytics, extended files/cron crash/load acceptance, delegated client membership and portable installation remain unfinished. Public licence/npm ownership matters for distribution, not use in this private account. Bounded same-project empty-target backup/restore is verified; off-account recovery, in-place restore and PITR are not implemented. Follow the [production runbook](production-runbook.md); do not treat an unperformed or cancelled soak as PASS.

## On-demand logical backup and empty-target recovery

Settings → Backups and `flared backup` use the existing private builds R2 bucket. A capsule includes the exact validated release, native document schema/data (preserving IDs, creation timestamps and revision) and copied ready file bytes. The checksum-verified manifest is written last. Incomplete capsules are not restorable. Only salted password hashes, never plaintext passwords, are included in the private credential capsule; active sessions, deployment credentials and signed file URLs are excluded.

Pause enabled cron and drain pending/running/failed jobs, actions and unfinished uploads before creation. The supervisor serial gate is held while the bounded snapshot and file copies complete: application calls may wait during this operation. This is an explicit maintenance operation, not a zero-impact background backup. Limits are 10,000 documents / 4 MiB logical data, 100 files / 100 MiB and 8 MiB manifest. Over-limit exports fail instead of truncating. Secrets, origins/OIDC configuration, schedules and historical jobs are intentionally omitted.

Restore is owner-only, explicitly confirmed and restricted to the other empty dev/prod environment of the same project. The target keeps its access configuration. A durable fence is persisted before copying/activation; application calls and deploys remain closed after failure/restart. Retry the same backup ID to complete. Source pins prevent deletion of a backup referenced by a restore. Do not manually clear the fence or pins to hide a failed recovery. This does not offer recovery into an occupied production database or arbitrary new project, nor off-account disaster recovery/PITR; those remain separate operational gates.

Backups are on-demand, with no polling, retention timer or additional bindings. Stored copies incur R2 storage/operation usage until explicitly deleted; partial capsules also require explicit deletion. Listing is paginated and reads metadata, not full manifests. The dashboard does not request backups until Manage backups is opened. Existing application releases must be rebuilt with the current SDK to expose native backup methods; the loader does not silently emulate missing methods.

Verification: 276 unit tests, 43 native checks (including forced supervisor abort during a fenced restore), independent packed installation, and seven real-cloud backup/release/auth checks PASS. Cloud proof uses disposable scopes only: 111 documents across pages, file bytes, exact release, owner/scope checks, occupied-target refusal, corrupted-file fencing, pinned deletion refusal and explicit repair/retry. `bun run test:backup:cloud` is an explicit operator workflow; it removes its own temporary project/resources after successful recovery. It is not run in CI or on customer production data.

## Breaking native-data preview

0.3 accepts only ABI 4, with `defineSchema`/`defineTable` and native CRUD/index/keyset API. No old SQL adapters or ABI fallback remain. A fresh environment/installation is required; local build/test/clean never resets deployed resources. Receipts/completed-or-failed job summaries retain 30 days and are cleaned in bounded batches on traffic, not an always-on timer. Sent outbox entries are removed only after Queue acknowledgement; old release metadata uses active/candidate/outbox/job reference checks; R2 builds use project/environment-scoped prefixes; their bounded retention protects active/candidate/outbox/job references before deleting blobs and metadata.

Current cloud proof: 16 checks including physical hibernation and 1002-record keyset traversal. Big Bang uses EnvironmentSupervisor with native declarative exports; it intentionally erased the prior namespace. Temporary acceptance projects are removed only after the active cloud run completes. Test app dev/prod use the immutable 0.3 tarball; do not overwrite a same-path private archive and assume Bun cache refreshes it — use a checksum-bearing filename.

## Bounded diagnostics, files and catalog retention

Successful one-off queries retain up to 100 in-memory summaries, lost on restart/hibernation, with no SQL logging writes. Mutation/action/errors retain durable recent summaries; logging failures do not replace completed application results. This is not complete Tail or billing history.

Files use keyset pagination, default 50 and maximum 100/page. Queue producer uses native sendBatch with count/UTF-8 byte bounds; consumer has individual ack/retry and concurrency four. Sent outbox rows are removed only after enqueue acknowledgement; delivery remains at-least-once.

D1 audit retains 90 days and expired credentials retain a 14-day grace. Cleanup is at most 1000 rows/category per pass on audited write traffic, with a durable lease; no scheduled GC wake. Job receipts retain 30 days on traffic. Old releases become eligible after 30 days, but the last five successful hashes and active/candidate/job/outbox references remain protected. Public UI caching never changes Access/membership checks for protected routes.

## Version history and application publishing

Health → Development/Production releases shows the latest five distinct successful builds of the selected environment; dates mean first publication, not every activation. Read-only contract inspection does not download source into the browser. Promote exports the selected immutable dev bundle and activates it in prod with an expected-current-hash check. Rollback uses the same compatible native activation path. Failed candidates cannot be selected. No dev documents, files or credentials are copied. This is code rollback, not database rollback.

`flared deploy/promote --cmd "bun run build"` builds the frontend against the selected production URL before backend publication. Dev `.env.local` is preserved. The application can then invoke native Wrangler to publish assets. This sequencing is intentionally not called atomic: a frontend publishing failure leaves the completed backend release active and must be reported/inspected. Schema changes must remain compatible with older clients. No automatic rollback of data or external effects is attempted.

The release cloud proof adds six successful variants, exact-hash promotion preserving 112 production documents, compatible rollback, stale-target conflict and failed-candidate exclusion. Temporary resources are removed after acceptance. The current production Astro playground also passes five browser checks and the local dev app passes nine cloud-backed checks. These results do not replace a new monthly cost estimate or full release crash/draining proof.

Not implemented: isolated historical application preview URLs, coordinated frontend/backend version history and automatic paired rollback. Existing history only records backend hashes; do not represent it as a full-stack snapshot.

## Release checkpoint 0.3.0-rc.1

This private prerelease is a reproducible checkpoint, not a claim that all production gates are closed. It supports the existing trusted-team installation. Dashboard Access stays enabled; functions requiring authentication accept enabled built-in password sessions or an explicitly configured OIDC issuer/audience. Built-in registration stays closed until the owner enables it for the selected environment. Start with non-sensitive projects and keep schema changes additive.

The native workerd harness forces supervisor abort at two real activation checkpoints: after the durable candidate journal and after facet schema commit, before marking the release active. A subsequent application query resumes activation, preserves document IDs and records successful history. Health reports `activating`, not `ready`, until recovery finishes. Fault injection is authenticated and compiled only into the test harness; it is absent from the production core.

Production rollout checklist:

- Run `bun run verify`, `bun run test:kernel` and `bun audit --production --audit-level=high`; deploy the tested Admin/Runtime builds explicitly.
- For each application configure only its frontend origins, built-in auth or OIDC issuer/audience, and required capabilities. Test unauthenticated, expired-token and cross-environment refusal before real user data.
- Use `flared dev` for cloud dev; use a tested immutable hash with `flared promote --env prod --hash HASH --cmd "bun run build"`, followed by native frontend publishing. Inspect partial-release errors; do not rewind the database automatically.
- Pause cron/drain jobs and create a logical backup before risky maintenance. Current restore requires an empty other environment and is not in-place recovery or off-account disaster recovery.
- Inspect failed jobs in Schedules and native Cloudflare DLQ. Automatic platform DLQ replay is not implemented; do not discard dead-letter messages. External effects must be idempotent.
- Monitor native Cloudflare usage/billing. Idle hibernation is verified; storage, traffic and running jobs are still billable. The $5 subscription is not a maximum invoice.

Not certified by this checkpoint: independent external OIDC-provider integration, arbitrary frontend/backend previews, full graceful draining under concurrent deployment, portable installation in another account, off-account disaster recovery, platform DLQ replay, comprehensive telemetry and a workload-specific monthly bill. Do not use the GitHub release label to imply those checks passed.

## Password-auth operations

The native auth cloud proof passes registration/login, context through query/action, wrong-origin/wrong-environment refusal, project-CLI management denial, password reset/live revocation and account blocking. This is a bounded self-hosted password feature, not a complete consumer identity product. No emails, MFA or anonymous recovery. Owner resets require Access; recovery of the Cloudflare owner account follows Cloudflare's own procedures.

Private backup capsules include salted user credential hashes to preserve IDs/ownership after empty-target restore. Treat capsule access as credential-store access, not a public export. Active sessions are intentionally discarded. Target auth settings remain unchanged and must be explicitly enabled after recovery; no automatic login or copied administrative privileges. Restoring onto an environment with existing users is rejected. Sessions/counters clean up on traffic, not periodic polling; idle storage still consumes storage quota.

## Local cleanup

`bun run clean` removes reproducible SDK/platform/dashboard output, tarballs,
acceptance reports, Wrangler/Vite/Astro caches and Finder metadata. It also removes
leftover Vite cache from the former root test app and prunes its empty directories.
The root `test` app no longer exists; maintained fixtures are under `tests/fixtures`.
Installed dependencies, tracked sources/tests, live Wrangler configurations,
installation state, credentials and nonempty CLI connections remain intact.
Cleanup never contacts Cloudflare. Build again before packaging or deployment.
