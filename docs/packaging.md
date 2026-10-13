# One application package

`@auersperg/flare` is a self-contained distribution, not a facade over unpublished SDK/CLI dependencies. SDK and CLI are MIT-licensed and prepared for public npm distribution. Source changes do not themselves publish npm; cloud deployment is a separate explicit lifecycle operation.

## Design

- `@auersperg/flare`: portable browser/server-JS client and references.
- `@auersperg/flare/server`: function declarations, validators and SQLite schema helpers.
- `@auersperg/flare/react`: hooks; React is an optional peer, not required by non-React apps.
- `@auersperg/flare/protocol`: serializable contracts.
- `@auersperg/flare/cloudflare`: build-time native adapters, not a frontend import.
- `dist/cli/flare.js`: Bun-only CLI, compiled separately with lazy chunks for help/login/compiler paths.

There are exactly two top-level source packages: `packages/flare` and `packages/core`.
SDK and CLI are modules inside `flare/src/sdk` and `flare/src/cli`, not separate
workspaces or packages. The SDK emits directly into `dist/sdk`; the lazy CLI emits
into `dist/cli`. Public exports point directly to these files, without forwarding
wrappers or copying an intermediate SDK build. Ordinary compiler dependencies
remain declared. Browser entry points never import CLI, Bun or Core.

Applications use one registry dependency, without vendor archives or overrides:

```json
{
  "dependencies": {
    "@auersperg/flare": "0.3.6"
  }
}
```

The npm preview is installed with `bun add @auersperg/flare@next`; commands remain `bunx --bun --package @auersperg/flare@next flare dev` and `bunx --bun --package @auersperg/flare@next flare deploy`. Source 0.3.5 extends platform install/status/update with explicit operator adoption and a reproducible checksummed `dist/platform` payload to this same archive; [platform lifecycle](platform-lifecycle.md) documents the implementation and remaining cloud gates.

## Verification

`bun run build && bun scripts/package-acceptance.mjs` builds and installs **only the flare archive** in a disposable directory outside the workspace. No internal archives, overrides or symlinks are allowed. Every installed package file must match the verified tarball's SHA-256; a fresh directory is not accepted as proof against stale package caches. It verifies the dependency graph, exact-version CLI help, native facet/action builds, immutable checksums, generated API/TypeScript/OpenAPI, an independent Astro/React frontend, portable Node client imports, and cleanup on build failure. No-flags `dev` also exercises expected-active-hash deployment against an intercepted mock control API. No requests reach Cloudflare and no application data is modified.

## Convex reference

Studied the official [`convex-js/package.json`](https://github.com/get-convex/convex-js/blob/main/package.json), [`scripts/build.cjs`](https://github.com/get-convex/convex-js/blob/main/scripts/build.cjs) and [`scripts/build.py`](https://github.com/get-convex/convex-js/blob/main/scripts/build.py). Convex distributes a single `convex` package, uses subpath exports/optional framework peers/`sideEffects: false`, and separately builds its standalone CLI. SDK JavaScript is compiled per module rather than mixed into a CLI entry. We adopt those boundaries, not their code or full CJS/auth/framework compatibility matrix. Flare keeps its ESM SDK, Bun build/CLI and Cloudflare-native server runtime.

## npm release

The SDK and CLI package is `@auersperg/flare`, under MIT. The repository and
core/dashboard use the same MIT license. Only
`packages/flare` is publishable; the root and platform workspaces remain private. Compiled Core/dashboard/bootstrap/migrations ship as CLI-only payload files, not public SDK exports. The npm archive still has no Wrangler/workerd dependency: the account CLI lazily invokes pinned Wrangler using its supported Node runtime.

For an application:

```sh
bun add @auersperg/flare@next
bun run --bun flare dev
```

Use `import {createClient} from "@auersperg/flare"` and the `/server`, `/react`,
`/protocol`, `/cloudflare` subpaths. The CLI binary and backend source folder
remain `flare`; the scoped npm name must never resolve to the unrelated `flare`
package in the registry.

For a maintainer, from the repository root:

```sh
bun install --frozen-lockfile
bun run test:kernel
bun pm pack --cwd packages/flare --destination artifacts/packages/flare
bun scripts/verify-package-artifact.mjs
npm publish artifacts/packages/flare/auersperg-flare-0.3.6.tgz --dry-run --ignore-scripts --access public --tag next
# Only after reviewing the archive and authorizing the public release:
npm publish artifacts/packages/flare/auersperg-flare-0.3.6.tgz --access public --tag next
```

The source package's `prepack` runs the full repository verification, including
independent installation of an archive produced with lifecycle scripts disabled
to avoid recursion. The first preview uses `next`, not `latest`. Publishing
requires npm rights for the `auersperg` scope and the account's 2FA or configured
trusted publishing. No npm credentials are stored in CI. A separate manually approved OIDC publication workflow is described below.
The GitHub repository is public and MIT-licensed.

## GitHub trusted publisher

Release workflow: `.github/workflows/publish.yml`, manually started from `main`.
It requires the exact manifest version and defaults to `next`. The protected
GitHub environment `npm` requires owner approval. The publication job alone
receives OIDC `id-token: write`; no permanent npm token is stored in GitHub.
PRs and ordinary pushes never publish. Checks, native kernel tests, dependency
audit and clean-source verification must pass before the archive is published
with provenance. The workflow publishes the exact tarball installed by package acceptance, without repacking it afterwards; its version and SHA-256 are verified immediately before publication. A changed archive or missing/failed acceptance report stops the release. npm rejects an already published version; releases are immutable.

npm trusted publisher settings:

- Publisher: GitHub Actions
- Organization/user: `auersperg`
- Repository: `flare`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allow `npm publish`: yes
- Allow independent `npm dist-tag`: not needed

A configured trust relationship is verified with `npm trust list @auersperg/flare`.
Configuration alone does not prove a successful OIDC release; that is confirmed
by the first approved publication run of a new version.

The 0.3.5 release adds `bun run test:platform:reproducible` before publication. Two frozen-lockfile builds at different absolute paths and the working-tree payload must have identical complete manifests. The private dashboard uses the workspace SDK and bounded Tailwind source discovery. There is no generated-output normalization or exception for differing payload digests.

The owner-approved 0.3.5 `next` publication passed [workflow 38295968332](https://github.com/auersperg/flare/actions/runs/38295968332). Exact registry integrity, all installed package files and the platform payload were verified outside the repository. The registry archive is byte-identical to the accepted local tarball; its CLI confirmed the adopted personal panel with a same-release no-op. `latest` remains 0.3.1. Details and remaining independent-account limits are in [platform lifecycle](platform-lifecycle.md).

Published 0.3.6 `next` was verified on October 13, 2026 through [workflow 38385348118](https://github.com/auersperg/flare/actions/runs/38385348118). Registry archive and all installed files match the accepted bytes; the personal panel was updated with that registry-installed CLI. `latest` remains 0.3.1. See the [current lifecycle evidence](platform-lifecycle.md#published-036-and-personal-update-verification).
