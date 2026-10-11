# Flared CLI 0.3

Internal source compiled into the single application-facing `flared` package. Bun 1.4.3+; no local dashboard or emulator.

```sh
bun add flared       # target registry flow; currently install a private packed archive
bunx flared dev     # browser approval → project → native schema/types → cloud-dev watch
bunx flared deploy  # build and confirm production deployment
```

Schema and functions live in `flared/`. `_generated/server.ts` supplies schema-typed query/mutation declarations; `_generated/api.ts` supplies browser-safe references. SQL journals and db-generation commands are not needed. Compilation/checksums happen locally, not on an application request. Frontend changes do not trigger backend deployment; framework-prefixed public URL env entries preserve other variables.

Advanced explicit commands:

```sh
flared build --entry app.ts --outdir release
flared link --platform https://api.example.com/control --project PROJECT_UUID
flared dev --entry app.ts
flared deploy --env dev --release release
```

Immutable output contains facet/action modules, `schema.json`, manifest, checksums, generated TypeScript API and OpenAPI 3.1. Only ABI 4 is accepted. No old `tables` declarations, `--migrations` flag or Drizzle pipeline.

Browser approval is protected by online Access/owner authorization and same-origin CSRF. Project-scoped credentials stay outside source/frontend env. Dev publishes to an already provisioned platform; general `platform init` is not implemented. No npm publication or cloud provisioning occurs during local verification.

## Immutable releases

```sh
bunx flared releases --env dev
bunx flared deploy --env prod --cmd "bun run build"
bunx flared promote --env prod --hash DEV_BUILD_HASH --cmd "bun run build"
bunx flared rollback --env prod --hash PREVIOUS_BUILD_HASH
```

History keeps the last five **distinct successful backend builds**, with their first publication date. Failed candidates are not promotable. Active builds and job/outbox references are protected from garbage collection. Repeating an unchanged build is not a new version.

Promote copies the selected immutable dev bundle to prod without recompiling or copying development data. Rollback activates compatible historical code against current data; it does not rewind the database. Both require explicit confirmation (`--confirm PROJECT_UUID` in CI), validate schema/job compatibility and compare the target's expected active hash. A changed target returns a conflict, never an automatic write retry.

`--cmd` generates client references for the exact selected bundle and builds the frontend **before** activating the backend. The child receives the selected environment URL via `FLARED_URL`, `PUBLIC_FLARED_URL`, `VITE_FLARED_URL`, `NEXT_PUBLIC_FLARED_URL` and `EXPO_PUBLIC_FLARED_URL`; local dev env files remain unchanged. A failed build does not publish backend code. Framework build variables must be public URLs, not credentials.

Frontend hosting stays with native Wrangler or another hosting tool. An application release script can sequence Flared + build + Wrangler. Frontend publication failure after backend activation is an explicit partial release, not an atomic transaction. Dashboard Health → Manage releases offers contract inspection, backend promotion and rollback on demand, with no polling. It does not publish the frontend.

Isolated historical preview environments and a paired frontend/backend version catalogue are not implemented. A saved backend hash is not a preview URL or a Git commit. Use additive contracts when old clients may remain active.

## On-demand backups

```sh
bunx flared backup list --env dev
bunx flared backup create --env dev --confirm PROJECT_UUID
bunx flared backup restore --from dev --env prod --id BACKUP_UUID --confirm PROJECT_UUID
bunx flared backup status --env prod
bunx flared backup delete --env dev --id BACKUP_UUID --confirm PROJECT_UUID
```

Writes require owner access and explicit confirmation (interactive `yes`, or the project UUID in CI). Creation prints its ID before sending the request; after an uncertain response retry explicitly with `--id` and that same ID. No automatic write retry. Restore copies data, IDs, creation timestamps, files and the exact backend build into the **other, empty environment of the same project**. It does not promote a release or overwrite an occupied production database.

Pause cron and drain jobs/actions/uploads first. Limits: 10,000 documents / 4 MiB logical data, 100 files / 100 MiB. Secrets, environment settings, schedules and job history are not copied. Interrupted restores stay closed to application calls and deployments; retry the same backup ID. The source backup cannot be deleted while a restore references it. Private R2 backups occupy storage until explicitly deleted; no periodic backup timer or extra service is installed. See the maintenance guide for recovery limitations.
