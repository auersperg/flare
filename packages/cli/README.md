# Flared CLI 0.2 private minimum

Thin tooling for the Cloudflare-hosted platform. The dashboard is online only; the CLI has no dashboard, Agents, Wrangler, workerd or backend-emulator dependency.

Implemented:

```sh
flared build --entry app.ts --migrations drizzle --outdir release
flared link --platform <runtime URL>/control --project <UUID>
flared dev --entry app.ts --migrations drizzle
flared deploy --env dev --release release
flared deploy --env prod --release release --confirm <UUID>
```

Set `FLARED_DEPLOY_TOKEN` from the online dashboard in your shell/CI secret store. It is project-scoped, expiring and revocable; never put it in frontend code. Link configuration contains only project IDs/URLs, not this credential.

Build evaluates trusted backend metadata, compiles facet/action roles, validates a native Drizzle migration journal, verifies immutable checksums and generates browser-safe TypeScript references/OpenAPI 3.1. Output must be a new directory. Deploy uses the hosted management API without automatic mutation retries. Dev watches source and publishes to cloud dev; start the application frontend independently.

Not implemented: `platform init`, `init`, `db generate`, any local dashboard/server. Native Drizzle tools generate migrations for now. Unsupported commands fail explicitly and do not pretend to deploy.

Local private tarballs, no npm publication; UNLICENSED pending an open-source license decision. See the platform README for actual acceptance and limitations.
