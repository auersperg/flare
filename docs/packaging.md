# One application package

`flared` is a self-contained distribution, not a facade over unpublished SDK/CLI dependencies. It stays private and UNLICENSED; this change does not publish anything or update Cloudflare.

## Design

- `flared`: portable browser/server-JS client and references.
- `flared/server`: function declarations, validators and SQLite schema helpers.
- `flared/react`: hooks; React is an optional peer, not required by non-React apps.
- `flared/protocol`: serializable contracts.
- `flared/cloudflare`: build-time native adapters, not a frontend import.
- `dist/cli/flared.js`: Bun-only CLI, compiled separately with lazy chunks for help/login/compiler paths.

There are exactly two top-level source packages: `packages/flared` and `packages/core`.
SDK and CLI are modules inside `flared/src/sdk` and `flared/src/cli`, not separate
workspaces or packages. The SDK emits directly into `dist/sdk`; the lazy CLI emits
into `dist/cli`. Public exports point directly to these files, without forwarding
wrappers or copying an intermediate SDK build. Ordinary compiler dependencies
remain declared. Browser entry points never import CLI, Bun or Core.

There is one private tarball and no overrides:

```json
{
  "dependencies": {
    "flared": "file:.packages/flared-0.3.1.tgz"
  }
}
```

After future registry publication, this becomes `bun add flared`; commands remain `bunx flared dev` and `bunx flared deploy`. Registry publication and a portable platform installer are separate unfinished work.

## Verification

`bun scripts/build-packages.mjs && bun scripts/package-acceptance.mjs` builds and installs **only the flared archive** in a disposable directory outside the workspace. No internal archives, overrides or symlinks are allowed. It verifies the installed dependency graph, lazy CLI entry, native facet/action builds, immutable checksums, generated public API/TypeScript/OpenAPI, an independent Astro/React frontend, portable Node client imports, and cleanup on build failure. It also exercises no-flags `dev` discovery/schema/API/env against an intercepted mock control API. No requests reach Cloudflare and no application data is modified.

## Convex reference

Studied the official [`convex-js/package.json`](https://github.com/get-convex/convex-js/blob/main/package.json), [`scripts/build.cjs`](https://github.com/get-convex/convex-js/blob/main/scripts/build.cjs) and [`scripts/build.py`](https://github.com/get-convex/convex-js/blob/main/scripts/build.py). Convex distributes a single `convex` package, uses subpath exports/optional framework peers/`sideEffects: false`, and separately builds its standalone CLI. SDK JavaScript is compiled per module rather than mixed into a CLI entry. We adopt those boundaries, not their code or full CJS/auth/framework compatibility matrix. Flared keeps its ESM SDK, Bun build/CLI and Cloudflare-native server runtime.
