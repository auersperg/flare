# Historical release evidence

Archived October 13, 2026. Current commands: [install/update](../platform-lifecycle.md).

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
# Cross-version proof: use two frozen archives, not mutable build output.
bun run test:platform:lifecycle:cloud --account ACCOUNT_ID --owner owner@example.com --confirm ACCOUNT_ID --from-archive /absolute/path/auersperg-flare-0.3.4.tgz --archive /absolute/path/auersperg-flare-0.3.5.tgz --report artifacts/platform-cross-version-cloud-acceptance.json
```

`--archive` selects the exact target tarball already verified by package acceptance; without it the gate packs current build output. Do not rebuild that output concurrently.

This gate generates its own `proof-XXXXXXXX` installation name; it cannot target an existing installation. It installs a real npm archive outside the repository, deliberately loses the final Runtime deploy acknowledgement, resumes the same release, tests an application canary and a same-version no-op update (or a declared cross-version update when `--from-archive` is supplied), discovers state without the local cache, and deletes only its verified disposable resources. A temporary authenticated RPC helper initializes the canary's empty backend; it compiles in only its two new scopes, never impersonates an Access owner, and is removed. Read-only readiness checks wait for newly created `workers.dev` routes to propagate; writes are not automatically retried. Cleanup compares the initial and final Worker/D1/R2/Queue/Access/domain/DO-namespace inventories. Failures retain a report and, if cleanup fails, the private scratch journal for scoped recovery. The cross-version gate preserves and checks real data, DO namespace/resource identities, application release, Access policy, a pre-update developer JWT, a password session, private R2 file bytes and a pending scheduled job. It uses two genuine immutable package payloads, not a renamed manifest. The script is not part of local verification, CI or npm publication.

The October 12 isolated-installation run used the Cloudflare connector for Access APIs because local Wrangler OAuth lacked Access permissions, and supported Wrangler auth for the other account APIs/deployments. This proves the lifecycle engine's real-cloud install/recovery and the packaged application CLI/SDK, not a full-scope-token platform CLI invocation. Earlier attempts exposed harness initialization/route-propagation and authenticated-fixture mistakes; those failed attempts are not counted as application acceptance. The corrected canary explicitly exposes only disposable CRUD, verifies the default-protected function rejects anonymous calls, and checks data and namespace/version preservation across a same-version no-op update. The final report is PASS with identical before/after account inventory digests; each failed attempt and cleanup outcome was kept separately.

The separate October 12 cross-version run upgraded the exact previously accepted 0.3.3 archive to the genuine 0.3.4 production payload (digest `ef11c29b3c637d35f12e74095851c3fbd108a163050ccb7456f6c89818dcff0d`). Native records, namespace/resource identities, app release, Access policy, a pre-update developer JWT, password session, private file bytes and a pending job all survived. Both Worker versions changed. Cleanup passed with the same account inventory digest `68b87a0aa36127f8e8a6acbb9eb6ef8fc25d07d1fd8ebeaa94e6db909c7aa21a`. The owner-browser proof visibly showed `adam@auer.wien` in the fresh managed dashboard; it is separate from the automated gate, which does not impersonate an Access user. Local ignored artifacts are `artifacts/platform-cross-version-cloud-acceptance.json` and `artifacts/platform-owner-browser-acceptance.json` (with screenshot). That acceptance run did not publish npm or update an existing installation.

Still required before recommending general production installation: independent-account/full-scope-token platform CLI install. A same-version no-op is not cross-version acceptance; the second run used two different production payloads. 0.3.5 adds explicit adoption of the supported standard operator layout; arbitrary resource/configuration reconciliation remains unsupported. Old operator acceptance scripts remain explicit and separate; they are not automatically redirected to a new installation or treated as these missing proofs. Do not rebuild or replace generated package files concurrently with archive acceptance; integrity validation intentionally rejects incomplete files and iCloud/Finder conflict copies.

## 0.3.5 adoption evidence

On October 12, the existing AUER operator installation was adopted by the compiled CLI installed from a candidate npm archive outside the repository, using one scoped account token and no connector bridge. The native D1 journal and Admin ↔ Runtime readiness passed. All four retained environments kept their application release, schema, documents, users/auth settings, file metadata and SHA-256 of file bytes. Catalogue project/environment/member rows, Access application/policies and namespace identities matched. Both dry-run and confirmed same-release update were no-ops without another Worker deployment. The fixed-scope read-only audit Worker was deleted and its ephemeral credential erased. Local evidence: `artifacts/platform-adoption-cloud-acceptance.json`. This is not an independent-account proof or a publication claim.

## 0.3.4 → 0.3.5 cloud evidence

On October 12, a separate disposable installation used the exact published 0.3.4 archive and frozen 0.3.5 candidate payload (`93fa2857c7f7536138cb3e3cb25d20739d058b3c9476c8d23dfda76b3d13a8d3`). The native lifecycle engine used one scoped account token, with no connector bridge. Final Runtime acknowledgement-loss recovery, the real external packaged application CLI/SDK canary, the declared cross-version update and cache-free D1 discovery passed. Records, resource/DO namespace identities, application release, Access policy, pre-update developer JWT/signing key, password session, private file bytes and a pending scheduled job were retained. Cleanup passed with identical initial/final account inventory digests. Evidence: `artifacts/platform-035-cross-version-cloud-acceptance.json`.

An earlier attempt stopped on Cloudflare Queue creation HTTP 500; it was not blindly retried and its complete scoped cleanup was verified before starting a new disposable proof. That failed report is retained separately. This engine test is distinct from the external compiled platform CLI adoption above, owner-browser sign-in and an independent-account fresh CLI install; the latter is still untested.

## Published 0.3.5 verification

The owner-approved [protected publication workflow](https://github.com/auersperg/flare/actions/runs/38295968332) passed all gates, including native platform acceptance, frozen-build reproducibility on Linux and the production dependency audit. The exact public registry tarball was then installed outside the repository: SHA-512 integrity and every one of its 63 files matched. Its SHA-256 is `03828763b988d0ec2f7ccf44e87a35f9cbd17a83a5e4979f56ed15e3ea965d3f`, identical to the locally accepted archive. The complete platform digest matches the adopted personal panel and cloud-upgrade target above. Portable Node SDK imports and compiled adoption help passed. The published CLI used one scoped token for real personal-installation status, dry-run update and confirmed same-release update: both updates were no-ops, Worker versions did not change and actual readiness remained healthy. Evidence: `artifacts/platform-035-registry-acceptance.json`. Registry `next` is 0.3.5; `latest` remains 0.3.1. No independent-account acceptance is claimed.

## Published 0.3.6 and personal update verification

On October 13, the owner-approved [protected publication workflow](https://github.com/auersperg/flare/actions/runs/38385348118) passed on source commit `602d57c`, including reproducibility, native gates and the production dependency audit. Registry `next` is 0.3.6; `latest` remains 0.3.1. SHA-512 integrity, all 63 externally installed files and SHA-256 `515031f93043b8c7d0ea9771b25c2c863073bee0d47d67e85c22ea4fbed6c1ad` match the accepted archive. Platform digest: `7693b5a3c9dfa589dea20618a0fcfe348841e9ffdf6beba78aecb200cd27256c`.

Four completed logical capsules preceded the personal update. The registry-installed compiled CLI ran ordinary `platform status`, `platform update --dry-run` and `platform update --confirm ACCOUNT_ID`. Runtime and Admin readiness passed; all four environments retained application releases, schemas, documents, users/auth settings, file metadata and file byte hashes. Catalogue rows, namespaces, bindings/secrets and custom-domain identities were retained. Confirmed same-release update and dry-run were no-ops without further Worker versions. Owner sign-in and production data were checked in the actual dashboard. Evidence: `artifacts/platform-036-registry-acceptance.json` and `artifacts/platform-036-personal-update-acceptance.json`.

Owner sign-in exposed an old primary Access hostname and a stale deleted-Worker destination. The owner's explicit repair request changed the primary destination to `dash.flare.auer.wien`, preserving app ID/audience/policies/session/security settings. The approved configuration change was checkpointed using the existing native installation lease/CAS after exact before/after validation. Drift enforcement was not disabled. This one-time operator repair does not add generic reconciliation or replace the normal CLI update flow. The temporary fixed-scope proof Worker was deleted and its ephemeral credentials erased.
