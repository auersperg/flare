# Flared SDK 0.2 preview

The application SDK for Flared, a Cloudflare-native platform installed into the operator's own account. The dashboard is hosted only in Cloudflare; this package contains no dashboard, administrative web server or backend emulator.

Public entry points:

- `@flared/sdk`: browser/server-JS `createClient`, typed `reference`, `FlaredError` and `FlaredClient`.
- `@flared/sdk/react`: React `useLive` hook.
- `@flared/sdk/server`: `defineApp`, `query`, `live`, `mutation`, `action`, validators and contracts, used at build time.
- `@flared/sdk/cloudflare`: native facet/action class factories for server bundles, never imported into a frontend.
- `@flared/sdk/protocol`: serializable protocol types and limits.

SDK client code does not require Agents, Wrangler, workerd or a Cloudflare Vite plugin. The Cloudflare adapter uses Drizzle as its server-side peer. Compilation is performed by the separate `@flared/cli` package.

Functions declare input and output validators implementing Standard Schema and Standard JSON Schema. Generated client references do not import backend application source. `createClient({url, getToken})` selects one project's environment; application users never receive platform administrative credentials. Mutations with ambiguous transport outcomes are not replayed automatically.

This is a private minimum, not a published npm release or a completed production platform. The client protocol, application gateway and JWT verification have regression coverage; the hosted dashboard is implemented. Independent production OIDC acceptance, cloud load tests and the other release gates remain open. See the platform README for the supported scope and remaining work.

No local dashboard mode exists. The previous SDK 0.1 is not included in this repository, and its package scope is not an alias for this package.

License: UNLICENSED pending an explicit open-source licensing decision. No registry ownership is implied.
