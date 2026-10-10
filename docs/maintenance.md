# Maintenance

## Production-focused source tree

Three product packages: Core, SDK, CLI. Core contains the online Astro/shadcn dashboard and an empty application bootstrap used when creating projects. No demonstration frontend, hard-coded developer-session endpoint or application workspace belongs in the production repository.

Task/counter fixtures exist only under tests or in disposable acceptance workspaces. Normal platform builds must never compile them, seed their tables/functions or depend on their directories. Existing cloud projects keep their releases/data; an empty bootstrap applies only to newly created projects after deploying the updated Admin.

Customer frontend/backend source belongs in separate application repositories. SDK and CLI install there independently of Core/dashboard. There is no local dashboard mode or platform-owned frontend development server.

## Build and dependency boundaries

- One npm workspace and lockfile; SDK/CLI 0.2.0, shared Admin/Runtime, Astro 7.3.8 and actual shadcn 4.21.4 preset `bKGijeGe`.
- Preset: Base UI Lyra / Stone / Geist / Lucide / subtle menu accent. Use checked-in components.json; don't add custom button/badge geometry.
- Native runtime dependencies remain pinned (Agents 0.28.0, Wrangler 4.149.0, Drizzle 0.45.4). UI maintenance does not add Cloudflare services or replace Dynamic Workers/Facets with per-project Workers.
- TypeScript 6.0.2 is supported by Astro/Volar's compiler API; don't force TypeScript 7 peers. Native Vite prerender resolution keeps the React virtual-module consumer and Astro cookie version bundled.
- Astro-generated bootstrap hashes feed Admin's strict CSP; no unsafe-inline/eval. Authenticated hashed assets use private immutable caching; API/HTML stay uncached.
- Lazy secondary views, cancelled requests and scope-keyed remounting prevent stale data. Dashboard has no polling/automatic subscription/token issuance. Function clients dispose on navigation.
- Add/Edit table prepares validated offline migrations, never arbitrary live SQL or destructive schema edits. App schema, function contracts and release checksums stay versioned together.
- CLI scratch directories clean up in finally after success/failure. Immutable release output cannot be overwritten.

## Verification

`npm run verify`: source checks, unit tests, production build verification and independent tarball package acceptance. The latter compiles both data-bearing test apps and an empty app, checks generated references/OpenAPI and builds an ephemeral Astro/React frontend with the packed SDK. Its external workspace is removed in finally.

`npm run test:kernel`: local workerd native kernel proof, separate from installed CLI dependencies and production bundles. `test:cloud-kernel`, `test:cloud-sdk` and `test:platform:cloud` are explicit operator workflows that may create cloud test resources/data; they do not run as part of verify.

`verify-build` is self-contained local bundle verification. It does not depend on historical acceptance reports, removed demos or an already logged-in cloud account. Never turn old load-test evidence into a current latency/cost guarantee.

Production dependency audit is separate from build tooling. The shadcn CLI registry dependencies currently carry a development-only transitive glob/braces advisory; do not force a downgrade or unverified replacement. Those registry tools are not shipped to the browser/Workers.

## Generated and private files

`npm run clean` removes SDK/Core build output, Astro/Wrangler caches, CLI scratch state, test reports/tarballs and Finder metadata. Build again before packaging or deployment. Installed node_modules and the lockfile are not temporary project code.

`.private` contains active operator installation/signing/test credentials. Never commit or package it; cleanup preserves it. Do not put deploy credentials in a frontend bundle. Old demos, generated files and historical proof are backed up outside the repository, not another source tree inside it.

Cleaning local files makes no Cloudflare request and does not remove customer projects, releases, SQLite data, DNS or Access policy. Keep Admin/Runtime installation configuration locally; Git tracks only `*.wrangler.example.json`. Local kernel configuration lives under tests/kernel, has no account ID and is test-only. An existing remote kernel uses a separate ignored `wrangler.cloud.json`; it is never selected implicitly by the secret helper.

## Repository workflow

Canonical repository: `auersperg/flared`, private, default branch `main`, UNLICENSED. All packages remain private to prevent accidental npm publication. Git excludes credentials, live account configuration, generated files and installed dependencies.

Keep changes small and reviewable. Run `npm run verify` and `npm run test:kernel` before merging. GitHub CI runs these checks and the production-dependency audit with read-only repository permissions and pinned actions; it has no Cloudflare credentials or deployment job. Cloud acceptance/deployment remains explicit operator work, not a push side effect.

Record changes to app contracts, migration semantics, auth boundaries and beta API compatibility in the architecture documentation. Never include credentials or authenticated callback URLs in an issue, commit or log. Dependency audit and local regression coverage are not a complete security assessment or production certification.

## Remaining production gates

Repository cleanup is not full production certification. Remaining scope: independent OIDC provider acceptance, full release draining/crash recovery, native cloud guarantees/load/cost verification, files/Secrets Store/egress/cron/analytics/export/restore, delegated client membership, portable installer, public licence and npm namespace ownership. See architecture and README for actual product boundaries.
