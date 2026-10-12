# Platform installation and updates

Source release **0.3.4** adds `flare platform install|status|update`. The exact npm release **0.3.4** is available under `next` as of October 12, 2026; `latest` remains 0.3.1. Registry installation, payload integrity and compiled CLI/portable SDK imports were checked outside the repository. Prefer the exact version, not a moving tag. Fresh install, interrupted final-deploy recovery, control-plane readiness, a real CLI/SDK native-data canary, same-version no-op update, cache-free discovery and scoped cleanup have passed in a disposable installation on the owner's existing Cloudflare account. A second disposable run passed the genuine **0.3.3 → 0.3.4** update with data/auth/files/pending-job preservation; the owner also signed in through real Cloudflare Access in the existing authorized browser. This is not independent-account or full-scope-token platform CLI acceptance. Source/package tests, native local workerd and real Cloudflare acceptance are separate proofs.

## Prerequisites and authorization

- Bun 1.4.3+ for Flare; Node 24.11+ for the pinned Wrangler subprocess, downloaded lazily by Bun when a platform operation needs it. SDK imports and application builds do not load Wrangler.
- Workers Paid, activated R2 and an existing Zero Trust organization. The installer does not purchase subscriptions or change account-wide Access protection. Read checks are not proof of all billing/write entitlements; Cloudflare enforces these during provisioning/deployment.
- A Cloudflare account token with Workers Scripts, D1, Workers R2 Storage, Queues and Access Apps/Policies read/write permissions, plus Access organization read permissions and account discovery when `--account` is omitted. Custom domains also require access to the relevant zones/routes. Wrangler OAuth can be used via the supported `wrangler auth token --json` interface, but it may lack Access permissions; the command then stops and explains the prerequisite.
- `FLARE_DEPLOY_TOKEN` is a project credential, **not** a Cloudflare account token. Account tokens never enter D1 installation state, SDK code, frontend env or platform Workers. A generated signing secret is supplied to the first Runtime version via an ephemeral mode-0600 secrets file, then preserved; it is not stored in installation checkpoints.

Do not paste credentials into command arguments or commit them. Set `CLOUDFLARE_API_TOKEN` through your shell/CI secret store. Wrangler keeps its own authorization; Flare does not parse its private files.

## First installation

For the published preview:

```sh
bunx --bun --package @auersperg/flare@0.3.4 flare platform install --account ACCOUNT_ID --owner owner@example.com --dry-run
bunx --bun --package @auersperg/flare@0.3.4 flare platform install --account ACCOUNT_ID --owner owner@example.com
```

For a source checkout, build and use the **compiled** CLI:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun packages/flare/dist/cli/flare.js platform install --account ACCOUNT_ID --owner owner@example.com --dry-run
bun packages/flare/dist/cli/flare.js platform install --account ACCOUNT_ID --owner owner@example.com
```

The published package contains the same interface and complete platform payload. Always verify the exact version before deployment; moving registry tags can change.

The default installation name is `default`; use `--name NAME` for an independent installation. Account ID confirmation is required before cloud writes (`--confirm ACCOUNT_ID` for non-interactive operation). Omitting account/owner uses interactive discovery/prompts. Names are 1–20 lowercase letters/digits/hyphens, starting with a letter.

By default Admin and Runtime use unique `workers.dev` hostnames. A missing account subdomain is provisioned only after confirmation; an existing one is not renamed. Alternatively supply both `--dashboard-host dashboard.example.com --runtime-host api.example.com` for custom domains. This disables both Workers' `workers.dev` and preview URLs. The installer refuses another Worker's hostname.

Steps: claim the deterministic D1 catalogue → create uniquely installation-scoped R2 buckets and Queue/DLQ → configure a hostname-based Access allow policy → apply catalogue migrations → verify owner membership → deploy Runtime bootstrap with its signing secret → deploy Admin → deploy final Runtime → verify readiness and closed dashboard.

Admin/Runtime's initial circular service dependency is internal to this sequence. No demonstration project or records are created. Runtime `health?ready=1` checks Admin/catalogue and the return Runtime RPC, version/payload and installation identity. Anonymous dashboard requests must redirect to the expected issuer or return 401/403. **The owner still needs to open the dashboard and verify actual sign-in.** The CLI does not impersonate an Access user, test an external identity provider, or declare full application/load acceptance.

## State, recovery and concurrency

The `flare_installation` singleton in D1 holds resource identities, versions, migration hashes, phase checkpoints and previous Worker version IDs. Local `~/.config/flare/platform/ACCOUNT-NAME.json` is a mode-0600 cache/early installation journal (override its parent with `FLARE_CONFIG_HOME`). Completed managed installations can be discovered from D1 on another computer without this file.

Before D1's checkpoint exists, keep the local early journal. A catalogue without verified managed state is not silently adopted. A legacy `flare-catalog` operator installation blocks a fresh default installation; the first release does **not** implement legacy adoption. Use an explicit future migration or an intentionally separate installation name; never recreate or reset existing DO namespaces as a workaround.

Every stage checks its outcome before advancing. Cloud writes and ambiguous Worker deployment outcomes are not automatically retried: rerun the original command/release to reconcile named resources and operation-tagged deployment versions. Idempotent GET account lookups have at most two bounded retries for transient network/5xx/rate-limit failures; authorization errors and SQL POSTs are never replayed. Partial operations must finish with the same payload before another release can run. No automatic deletion of partially provisioned resources is performed.

D1 revision compare-and-swap and a 15-minute lease serialize operations. Graceful failure releases the lease but retains checkpoints. Following a killed process, wait for the lease to expire and explicitly add `--resume`. This does not override a live lease. The updater rejects state that changed after the plan was prepared.

## Update semantics

```sh
flare platform status --account ACCOUNT_ID
flare platform update --account ACCOUNT_ID --dry-run
flare platform update --account ACCOUNT_ID
```

The target is the payload bundled with the running CLI, not a downloaded moving `latest` platform. Maintainers publish a new immutable package for different bytes. Same version/different digest, downgrades, protocol/ABI mismatch and undeclared version transitions are rejected. `upgradeFrom` is an explicit manifest allowlist; **the first 0.3.3 manifest has an empty list**, because no preceding release has managed installation state. The 0.3.4 candidate declares **0.3.3** as its compatible source; this transition passed the real-cloud gate. Each declared transition must pass the cross-version gate before release. Future versions must declare and test supported source versions. Always preserve the exact registry archive for future upgrade acceptance; rebuilding the same source can change Astro’s SSR island identifier and therefore the payload digest. The published 0.3.4 digest is `b2a9b9ba43b5bd2514c26eb40e9e99792b1a20387d8503f9284dc853781fd78e`; comparison with the cloud-tested candidate found only that one identifier difference, with identical executable/migration/bootstrap/other asset bytes and release contracts. The published manifest itself was not separately cloud-deployed.

Updates apply additive D1 migrations, then Runtime and Admin, then verify. Previously applied migration files must remain byte-identical. Workers update sequentially, not atomically; compatible intermediate states and possible client reconnection are part of the release contract. There is no zero-downtime or full graceful job/action-drain guarantee in this preview.

Worker names, catalogue IDs, R2/Queue identities, supervisor namespace, `app` facets, projects, app releases, application data/auth/files and signing secrets are not replaced. Existing Access policies are not edited during updates. Out-of-band Worker configuration/version changes are refused rather than overwritten; arbitrary configuration adoption/reconciliation is not implemented yet. Additional unmanaged bindings/domains must not be added expecting the updater to merge them automatically.

`platform update` does not update the SDK in application repositories or redeploy their frontends/backends. `flare deploy/promote/rollback` remain application commands. Platform Worker version IDs are retained for investigation, not a promise of automatic code/data rollback. No data rewind, destructive reverse migrations, unattended updates or updater service is installed.

## Release and verification

`scripts/package-platform.mjs` stages production Admin/Runtime, assets/bootstrap and migrations into `packages/flare/dist/platform`. The manifest inventories SHA-256/length for every file. The CLI validates the inventory and stages a second verified copy before authorization/provisioning. The npm package remains the only package; payload files are not public browser exports. Integrity hashes detect corruption/mismatch, not an independent signature or authorization of arbitrary packages; distribution relies on exact npm releases and existing trusted publishing/provenance.

Local gates:

```sh
bun run verify
bun run test:kernel
bun run test:platform:local
```

Mock lifecycle tests use real isolated SQLite for D1 statements and synthetic Cloudflare inventories/deployments, including partial failure, lost acknowledgement, version/namespace/secret preservation, drift refusal and leases. Package acceptance verifies the installed payload and read-only platform plan outside the repository. Native platform acceptance uses production bundles, local migrations and real mutual service bindings without account credentials or cloud writes.

Explicit disposable cloud gate (requires the full account-token permissions above):

```sh
bun run build
bun run test:platform:lifecycle:cloud --account ACCOUNT_ID --owner owner@example.com --confirm ACCOUNT_ID
# Cross-version proof: preserve the exact earlier accepted npm archive.
bun run test:platform:lifecycle:cloud --account ACCOUNT_ID --owner owner@example.com --confirm ACCOUNT_ID --from-archive /absolute/path/auersperg-flare-0.3.3.tgz --report artifacts/platform-cross-version-cloud-acceptance.json
```

This gate generates its own `proof-XXXXXXXX` installation name; it cannot target an existing installation. It installs a real npm archive outside the repository, deliberately loses the final Runtime deploy acknowledgement, resumes the same release, tests an application canary and a same-version no-op update (or a declared cross-version update when `--from-archive` is supplied), discovers state without the local cache, and deletes only its verified disposable resources. A temporary authenticated RPC helper initializes the canary's empty backend; it compiles in only its two new scopes, never impersonates an Access owner, and is removed. Read-only readiness checks wait for newly created `workers.dev` routes to propagate; writes are not automatically retried. Cleanup compares the initial and final Worker/D1/R2/Queue/Access/domain/DO-namespace inventories. Failures retain a report and, if cleanup fails, the private scratch journal for scoped recovery. The cross-version gate preserves and checks real data, DO namespace/resource identities, application release, Access policy, a pre-update developer JWT, a password session, private R2 file bytes and a pending scheduled job. It uses two genuine immutable package payloads, not a renamed manifest. The script is not part of local verification, CI or npm publication.

The October 12 isolated-installation run used the Cloudflare connector for Access APIs because local Wrangler OAuth lacked Access permissions, and supported Wrangler auth for the other account APIs/deployments. This proves the lifecycle engine's real-cloud install/recovery and the packaged application CLI/SDK, not a full-scope-token platform CLI invocation. Earlier attempts exposed harness initialization/route-propagation and authenticated-fixture mistakes; those failed attempts are not counted as application acceptance. The corrected canary explicitly exposes only disposable CRUD, verifies the default-protected function rejects anonymous calls, and checks data and namespace/version preservation across a same-version no-op update. The final report is PASS with identical before/after account inventory digests; each failed attempt and cleanup outcome was kept separately.

The separate October 12 cross-version run upgraded the exact previously accepted 0.3.3 archive to the genuine 0.3.4 production payload (digest `ef11c29b3c637d35f12e74095851c3fbd108a163050ccb7456f6c89818dcff0d`). Native records, namespace/resource identities, app release, Access policy, a pre-update developer JWT, password session, private file bytes and a pending job all survived. Both Worker versions changed. Cleanup passed with the same account inventory digest `68b87a0aa36127f8e8a6acbb9eb6ef8fc25d07d1fd8ebeaa94e6db909c7aa21a`. The owner-browser proof visibly showed `adam@auer.wien` in the fresh managed dashboard; it is separate from the automated gate, which does not impersonate an Access user. Local ignored artifacts are `artifacts/platform-cross-version-cloud-acceptance.json` and `artifacts/platform-owner-browser-acceptance.json` (with screenshot). That acceptance run did not publish npm or update an existing installation.

Still required before recommending general production installation: independent-account/full-scope-token platform CLI install. A same-version no-op is not cross-version acceptance; the second run used two different production payloads. Legacy adoption is not implemented. Old operator acceptance scripts remain explicit and separate; they are not automatically redirected to a new installation or treated as these missing proofs. Do not rebuild or replace generated package files concurrently with archive acceptance; integrity validation intentionally rejects incomplete files and iCloud/Finder conflict copies.
