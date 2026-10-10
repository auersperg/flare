# Flared

[![CI](https://github.com/auersperg/flared/actions/workflows/ci.yml/badge.svg)](https://github.com/auersperg/flared/actions/workflows/ci.yml)

Cloudflare-native reactive backend in your own account.

**0.2 · private minimum.** One installation, multiple projects, isolated cloud `dev` / `prod`. The repository contains the platform, SDK, CLI and verification tools, not customer applications or demonstration frontends. It is not yet a complete Convex replacement or a public npm release.

## Product

- **Core:** shared Admin Worker + Astro/shadcn static dashboard, Runtime Worker, Dynamic Workers, supervisor Durable Objects and persistent SQLite `app` facets.
- **SDK:** queries, live subscriptions, mutations, actions, React hooks, generated browser-safe TypeScript references and OpenAPI 3.1.
- **CLI:** thin build/link/cloud-dev/deploy tooling. No local dashboard, backend emulator or Cloudflare administrative credentials in client bundles.

The dashboard is **Cloudflare-hosted only**, protected by Cloudflare Access, and not required for application traffic. D1 holds the administrative catalogue/audit only; application data lives in its environment facet. R2 stores immutable releases; Queues deliver transactional outbox jobs. Frontends deploy independently.

New projects start **empty**, with no demo tables, functions or records. Define their schema/functions in the application's own repository and deploy a release. Existing cloud projects are never reset by building or cleaning this repository.

## Repository

| Directory       | Purpose                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `packages/core` | Platform runtime, online dashboard, D1 migrations, empty project bootstrap |
| `packages/sdk`  | Client, React hooks, server declarations and native adapters               |
| `packages/cli`  | Application compilation and deployment commands                            |
| `tests`         | Regression tests and small test-only fixtures, never production seeds      |
| `scripts`       | Reproducible builds, packaging checks and explicit cloud acceptance        |
| `docs`          | Architecture, operations and remaining production gates                    |

One npm workspace and lockfile. Installed dependencies, generated output and credentials are ignored. No `apps`/`examples` workspace or duplicated demo toolchain. The task fixture under tests is used only by explicit acceptance scripts; production builds do not consume it.

[Architecture](docs/architecture.md) · [Maintenance](docs/maintenance.md) · Product constraints: `flared.product.json`.

## Build and verify

Node **24.11+**, npm. Clone the private repository with an authorised GitHub account:

```sh
git clone https://github.com/auersperg/flared.git
cd flared
npm ci --ignore-scripts
npm run verify
# Additional native kernel verification, local test-only workerd:
npm run test:kernel
# Remove generated output and temporary reports:
npm run clean
```

`verify` checks source types, unit tests, production bundles/CSP/bootstrap and real SDK/CLI tarball installation in a disposable external workspace. The package proof builds an ephemeral independent Astro/React frontend; no persistent demo is copied into the repository. Its workspace is removed on success or failure.

GitHub CI repeats verification, local native kernel checks and the production-dependency audit on Node 24/Linux. It needs no Cloudflare credentials, creates no cloud resources and does not deploy or publish packages. A green CI run is not full production acceptance.

`build` emits only SDK output, the two shared Workers, the static online dashboard and the empty bootstrap release. `clean` removes ignored builds, reports, caches and Finder metadata, not source, installed dependencies, operator credentials or cloud data. Run `build` again before packaging/deployment.

Dashboard: Astro 7.3.8, React 19.3.0, actual shadcn `bKGijeGe` preset (Base UI Lyra / Stone / Geist / Lucide). Secondary views are lazy-loaded; no SSR adapter, background polling or automatic live subscription. TypeScript 6.0.2 remains the supported Astro/Volar checker rather than forcing an unsupported compiler API.

## Application development

Customer code belongs in **a separate repository**, not in this platform workspace. SDK/CLI packages currently install from locally generated tarballs, not public npm.

1. Create/select a project in the online dashboard.
2. Configure allowed frontend origins and production OIDC.
3. Issue a project-scoped CLI credential; store it in your shell/CI as `FLARED_DEPLOY_TOKEN`, never frontend code.
4. Install SDK/CLI tarballs and define `app.ts` plus ordered Drizzle migrations in your application repository.
5. Link, build and deploy:

```sh
flared link --platform https://api.example.com/control --project <UUID>
flared build --entry app.ts --migrations drizzle --outdir release
flared deploy --env dev --release release
flared dev --entry app.ts --migrations drizzle
flared deploy --env prod --release release --confirm <UUID>
```

Start the frontend with its own framework's development server. Flared backend dev runs in Cloudflare. Obtain short-lived developer identities in the online dashboard; use user OIDC tokens in production. Environment URLs are public configuration; administrative credentials are not.

`platform init`, `init` and `db generate` are not implemented. Use native Drizzle tooling for migration generation. Code rollback is not database rollback; applied migrations must never be overwritten.

## Dashboard

Seven primary sections: **Health, Data, Schema, Functions, Files, Schedules, Logs**. Project/environment selection is in the header; Settings is under the gear, SDK setup under Health.

- Real paginated data, typed add/edit forms, explicit NULL/defaults, revision checks, immutable primary keys, audit and production confirmation.
- Add/Edit table prepares an offline SQL/Drizzle draft, not an immediate live schema write. Review and deploy schema with the application release.
- Shared yellow query / blue mutation / purple action / green live badges; typed arguments, tabular results. Function execution is explicit, dev-only, not for viewers or live functions.
- Actual invocation summaries and job receipts, not simulated Tail/billing analytics. Unavailable file/cron capabilities are labelled honestly.
- Owner/editor/viewer checks, verified Access identity, same-origin CSRF protections and strict build-generated CSP.

## Operations and boundaries

Installation configuration stays local and is ignored by Git. Copy `admin.wrangler.example.json` and `runtime.wrangler.example.json` to the corresponding `*.wrangler.json` files and replace every placeholder with your own account, resource IDs, runtime URL and Access issuer/audience. These examples describe bindings, not an automatic installer. Existing configured installations keep their local files unchanged.

A fresh installation requires Workers Paid/Dynamic Workers availability, D1, R2, Queues/DLQ, a signing secret, Cloudflare Access and owner membership. Admin and Runtime refer to each other: use a temporary Runtime bootstrap without its Admin service binding before the first Admin deployment. `scripts/setup-cloud.mjs` handles this for the existing macOS operator workflow, but reads local Wrangler OAuth and is **not** a portable, production-approved installer. Do not treat copying examples or deploying Admin alone as a complete first installation.

For an **already provisioned and protected installation**:

```sh
npm run deploy:dashboard
# Only when Runtime source changed:
npm run build
npx wrangler deploy --config runtime.wrangler.json
```

Commit only the configuration examples, never live installation files. `tests/kernel/wrangler.json` has no account ID and is for local native testing. For remote kernel testing, create a separate ignored `tests/kernel/wrangler.cloud.json` for disposable resources and explicitly select it when deploying. `scripts/set-kernel-secret.mjs` requires `FLARED_KERNEL_CONFIG`; acceptance scripts require `FLARED_KERNEL_URL`. `.private` retains installation checkpoints and test/signing credentials, never packaged or committed.

Explicit cloud acceptance commands can create test resources/projects and write test data. They are not part of `verify`, and must not target customer production data. Production builds/cleanup perform no cloud operations.

Dynamic Workers/Facets/Lifecycle depend on beta/experimental Cloudflare APIs. Supported scope is trusted applications/team members, not public untrusted multi-tenancy. Files, Secrets Store, controlled external action egress, cron management, full analytics, export/restore, complete release draining, portable installer and client-specific delegated membership remain unfinished. Protected production functions without OIDC stay closed. Queues are at-least-once; ambiguous mutations are not automatically retried.

No guarantee that $5 covers total usage or that Flared is cheaper/faster than Convex for every workload. This repository and all packages are private and **UNLICENSED**. No open-source licence is granted; public visibility, licensing and npm publication require a separate decision.

## Release status

Use 0.2 for a controlled, trusted-team installation only. Before treating it as a general production backend, complete the [production gates](docs/maintenance.md#remaining-production-gates): independent installation/OIDC, release recovery, load/cost tests, backup/restore and the unfinished service capabilities. No runtime architecture was replaced just to make repository checks pass.
