# Platform installation and updates

Current release **0.3.8** implements `flare platform install|status|update|adopt` (adoption introduced in 0.3.5). Exact npm **0.3.8** is available under `next` as of October 13, 2026; `latest` remains 0.3.1. Registry installation and the personal 0.3.7 → 0.3.8 managed update/resume/no-op are verified. Independent-account acceptance remains untested.

0.3.8 adds operator capabilities config, semantic Access snapshots and read-only live status. See the [implementation and acceptance report](archive/implementation-0.3.8-report.md) for exact package/CI evidence and remaining cloud permission/recovery boundaries.

## Prerequisites and authorization

- Bun 1.4.3+ for Flare; Node 24.11+ for the pinned Wrangler subprocess, downloaded lazily by Bun when a platform operation needs it. SDK imports and application builds do not load Wrangler.
- Workers Paid, activated R2 and an existing Zero Trust organization. The installer does not purchase subscriptions or change account-wide Access protection. Read checks are not proof of all billing/write entitlements; Cloudflare enforces these during provisioning/deployment.
- A Cloudflare account token with Workers Scripts, D1, Workers R2 Storage, Queues and Access Apps/Policies read/write permissions, plus Access organization read permissions and account discovery when `--account` is omitted. Custom domains also require access to the relevant zones/routes. Wrangler OAuth can be used via the supported `wrangler auth token --json` interface, but it may lack Access permissions; the command then stops and explains the prerequisite.
- `FLARE_DEPLOY_TOKEN` is a project credential, **not** a Cloudflare account token. Account tokens never enter D1 installation state, SDK code, frontend env or platform Workers. A generated signing secret is supplied to the first Runtime version via an ephemeral mode-0600 secrets file, then preserved; it is not stored in installation checkpoints.

Do not paste credentials into command arguments or commit them. Set `CLOUDFLARE_API_TOKEN` through your shell/CI secret store. Wrangler keeps its own authorization; Flare does not parse its private files.

## First installation

For the published preview:

```sh
bunx --bun --package @auersperg/flare@0.3.8 flare platform install --account ACCOUNT_ID --owner owner@example.com --dry-run
bunx --bun --package @auersperg/flare@0.3.8 flare platform install --account ACCOUNT_ID --owner owner@example.com
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

Before D1's checkpoint exists, keep the local early journal. A catalogue without verified managed state is not silently adopted. A legacy `flare-catalog` operator installation blocks a fresh default installation; use **explicit** `platform adopt` for the supported original operator layout, or an intentionally separate installation name. Never recreate or reset existing DO namespaces as a workaround.

Every stage checks its outcome before advancing. Cloud writes and ambiguous Worker deployment outcomes are not automatically retried: rerun the original command/release to reconcile named resources and operation-tagged deployment versions. Idempotent GET account lookups have at most two bounded retries for transient network/5xx/rate-limit failures; authorization errors and SQL POSTs are never replayed. Partial operations must finish with the same payload before another release can run. No automatic deletion of partially provisioned resources is performed.

D1 revision compare-and-swap and a 15-minute lease serialize operations. Graceful failure releases the lease but retains checkpoints. Following a killed process, wait for the lease to expire and explicitly add `--resume`. This does not override a live lease. The updater rejects state that changed after the plan was prepared.

## Explicit operator adoption (0.3.5)

`platform adopt` is a one-time, explicit transition, not an implicit fallback from install. It supports only the original standard `flare-admin` / `flare-runtime`, `flare-catalog`, `flare-builds` / `flare-files`, `flare-jobs` / DLQ layout, with existing custom domains, owner membership, ABI/protocol and an admitted source version. It refuses unknown bindings, nonstandard settings, competing catalogues and mismatched routing/identity. It never creates replacement cloud resources, rewrites Access policy or rotates secrets.

```sh
flare platform adopt --account ACCOUNT_ID --owner existing-owner@example.com --dry-run
flare platform adopt --account ACCOUNT_ID --owner existing-owner@example.com
flare platform status --account ACCOUNT_ID
flare platform update --account ACCOUNT_ID --dry-run
```

Use a CLI containing this command (published 0.3.5; the older 0.3.4 CLI cannot adopt). The existing D1 catalogue becomes the authoritative installation journal and uses the same native CAS lease/checkpoints/recovery as install/update. Worker/resource/namespace names and IDs, rate-limit namespace and developer issuer are retained. Runtime and Admin are updated sequentially to the bundled release, then real managed readiness is checked. After adoption, updates use the ordinary `platform update`, not the old setup script or direct Wrangler deployment. A fresh machine can discover the adopted default installation from D1 without a local cache. Previously applied migration names are checked against the supported target; adoption establishes checksum history for the managed target, not a fabricated hash history of old operator deployments. Read-only plan creates no journal or cloud resources.

## Reproducible release payloads

The dashboard is a client-only React application mounted by Astro's native bundled script, not an unnecessary SSR/hydration island. No path-derived island IDs enter HTML. Tailwind scans only maintained dashboard source; the private dashboard consumes the same workspace SDK, not a stale registry alias. No generated HTML rewrite or hash exception is used.

`bun run test:platform:reproducible` builds twice with a frozen lockfile in isolated directories at different absolute paths and requires identical complete platform manifests and all file hashes. The protected publish workflow runs this gate and publishes only the exact independently installed/tested tarball, with SHA-256 checked immediately before npm publish. Releases remain immutable; retain the exact registry archive for future upgrade tests. Version 0.3.4 is untouched; these changes shipped in the new immutable 0.3.5 release.

## Update semantics

```sh
flare platform status --account ACCOUNT_ID
flare platform update --account ACCOUNT_ID --dry-run
flare platform update --account ACCOUNT_ID
```

The target is the payload bundled with the running CLI, not a downloaded moving `latest` platform. Maintainers publish a new immutable package for different bytes. Same version/different digest, downgrades, protocol/ABI mismatch and undeclared version transitions are rejected. `upgradeFrom` is an explicit manifest allowlist. The published 0.3.8 supports the exact published 0.3.7 source only; preservation passed the cloud transition before publication and the ordinary published-CLI personal update afterwards. The first personal verification stopped after both Workers deployed; the same registry CLI completed `--resume` without redeploying. Four complete pre/post capsule pairs and read-only live state matched; a repeated confirmed update was unchanged. Archived releases are immutable; preserve their exact registry archives for future acceptance. Since 0.3.5, clean builds at different paths must produce identical full platform manifests.

Updates apply additive D1 migrations, then Runtime and Admin, then verify. Previously applied migration files must remain byte-identical. Workers update sequentially, not atomically; compatible intermediate states and possible client reconnection are part of the release contract. There is no zero-downtime or full graceful job/action-drain guarantee in this preview.

Worker names, catalogue IDs, R2/Queue identities, supervisor namespace, `app` facets, projects, app releases, application data/auth/files and signing secrets are not replaced. Existing Access policies are not edited during updates. Out-of-band Worker configuration/version changes are refused rather than overwritten; arbitrary configuration adoption/reconciliation is not implemented yet. Additional unmanaged bindings/domains must not be added expecting the updater to merge them automatically.

`platform update` does not update the SDK in application repositories or redeploy their frontends/backends. `flare deploy/promote/rollback` remain application commands. Platform Worker version IDs are retained for investigation, not a promise of automatic code/data rollback. No data rewind, destructive reverse migrations, unattended updates or updater service is installed.

## Operator configuration and live status

`platform status` keeps installation `status` separate from `health`. Probes are read-only and bounded: expected Runtime/catalog/Admin payload readiness, unauthenticated dashboard closure and semantic Access app/policy digest. Network/permission errors mean unavailable, not healthy/not-installed. Actual owner sign-in is still separate. There is no monitoring timer.

`platform install/update --config operator.json` accepts only complete desired `capabilities` and native `secrets` references. Omission on update preserves managed config; an explicit empty `{}` removes grants. The same release can deploy a config change without replacing data/namespace. Interrupted operations resume with their stored config; supplying a different config is refused. This does not accept arbitrary Wrangler settings or out-of-band bindings.

```json
{
  "capabilities": {
    "00000000-0000-4000-8000-000000000001/prod": {
      "outbound": ["api.example.com"],
      "secrets": { "API_KEY": "APP_SECRET_API_KEY" }
    }
  },
  "secrets": [
    {
      "binding": "APP_SECRET_API_KEY",
      "store_id": "00000000000000000000000000000000",
      "secret_name": "application-api-key"
    }
  ]
}
```

Replace example project/store IDs with your own. Create the secret in Cloudflare Secrets Store with Workers scope first; Flare config contains only its reference, not its value. This optional capability requires **Account Secrets Store Edit** on the deployment token; Read alone cannot bind a secret to a Worker. The secret must include the `workers` scope. These are native [Cloudflare access checks](https://developers.cloudflare.com/secrets-store/access-control/), separate from the base installation permissions. Only Runtime receives bindings; grants are project/environment scoped and outbound remains exact HTTPS hosts, bounded bodies/deadline, no redirects. App code never receives the account token.

Access snapshots guard the app's security fields and separate policy list while excluding only known response timestamps. Unknown fields remain guarded. Legacy snapshots migrate only after the old exact hash matches; legacy drift requires explicit review. If an intentional Cloudflare Access change blocks update, inspect it in Cloudflare and take the current `health.access.snapshot` from `platform status`. Then run:

```sh
flare platform update --account ACCOUNT_ID --accept-access REVIEWED_SHA256 --dry-run
flare platform update --account ACCOUNT_ID --accept-access REVIEWED_SHA256
```

This accepts exactly the reviewed app/policies under the existing installation CAS lease; it does not edit policies, change audience/issuer/host, accept Worker drift or disable protection. Another change before acceptance invalidates the digest. Keep an operator out of a pending update until it finishes; snapshot acceptance cannot hide an incomplete operation.

## Release and verification

The same npm archive contains the CLI and verified platform payload. CI runs local source/type/package/native checks without cloud credentials. Protected publication adds clean-build reproducibility and publishes the exact accepted archive, without repacking. Cloud lifecycle acceptance is manual, against disposable installations, never retained customer environments.

Independent-account installation, full graceful drain and off-account disaster recovery are not verified. A same-release no-op is not a cross-version proof. See the [runbook](production-runbook.md) for recovery and operational limitations. Historical release evidence is retained in `docs/archive/`, not in the current command guide.
