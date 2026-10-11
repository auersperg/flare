# One application package

`@auersperg/flare` is a self-contained distribution, not a facade over unpublished SDK/CLI dependencies. SDK and CLI are MIT-licensed and prepared for public npm distribution. This change does not publish anything or update Cloudflare.

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

There is one SDK/CLI tarball and no overrides:

```json
{
  "dependencies": {
    "@auersperg/flare": "file:.packages/auersperg-flare-0.3.1.tgz"
  }
}
```

After future registry publication, this becomes `bun add @auersperg/flare@next`; commands remain `bunx --bun --package @auersperg/flare@next flare dev` and `bunx --bun --package @auersperg/flare@next flare deploy`. Registry publication and a portable platform installer are separate unfinished work.

## Verification

`bun scripts/build-packages.mjs && bun scripts/package-acceptance.mjs` builds and installs **only the flare archive** in a disposable directory outside the workspace. No internal archives, overrides or symlinks are allowed. It verifies the installed dependency graph, lazy CLI entry, native facet/action builds, immutable checksums, generated public API/TypeScript/OpenAPI, an independent Astro/React frontend, portable Node client imports, and cleanup on build failure. It also exercises no-flags `dev` discovery/schema/API/env against an intercepted mock control API. No requests reach Cloudflare and no application data is modified.

## Convex reference

Studied the official [`convex-js/package.json`](https://github.com/get-convex/convex-js/blob/main/package.json), [`scripts/build.cjs`](https://github.com/get-convex/convex-js/blob/main/scripts/build.cjs) and [`scripts/build.py`](https://github.com/get-convex/convex-js/blob/main/scripts/build.py). Convex distributes a single `convex` package, uses subpath exports/optional framework peers/`sideEffects: false`, and separately builds its standalone CLI. SDK JavaScript is compiled per module rather than mixed into a CLI entry. We adopt those boundaries, not their code or full CJS/auth/framework compatibility matrix. Flare keeps its ESM SDK, Bun build/CLI and Cloudflare-native server runtime.

## npm release

The SDK and CLI package is `@auersperg/flare`, under MIT. The repository and
private core/dashboard retain their existing UNLICENSED status. Only
`packages/flare` is publishable; the root and platform packages remain private.

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
npm publish artifacts/packages/flare/auersperg-flare-0.3.1.tgz --dry-run --ignore-scripts --access public --tag next
# Only after reviewing the archive and authorizing the public release:
npm publish artifacts/packages/flare/auersperg-flare-0.3.1.tgz --access public --tag next
```

The source package's `prepack` runs the full repository verification, including
independent installation of an archive produced with lifecycle scripts disabled
to avoid recursion. The first preview uses `next`, not `latest`. Publishing
requires npm rights for the `auersperg` scope and the account's 2FA or configured
trusted publishing. No npm credentials or automatic publication are added to CI.
Public npm artifacts do not make the private GitHub repository public.
