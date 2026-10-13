// Native Cloudflare bindings, kept separate from Worker implementations.
import type { AdminControl } from "./admin.js";
import type { RuntimeBinding } from "./rpc-contract.js";

interface PlatformIdentity {
  RUNTIME_URL: string;
  FLARE_INSTALLATION_ID?: string;
  FLARE_PLATFORM_PAYLOAD?: string;
}

export interface AdminEnv extends PlatformIdentity {
  CATALOG: D1Database;
  RUNTIME: RuntimeBinding;
  ASSETS: Fetcher;
  DASHBOARD_URL: string;
  ACCESS_ISSUER: string;
  ACCESS_AUD: string;
}

export interface RuntimeEnv extends PlatformIdentity {
  APP_CAPABILITIES?: string;
  LOADER: WorkerLoader;
  SUPERVISORS: DurableObjectNamespace;
  BUNDLES: R2Bucket;
  FILES?: R2Bucket;
  JOBS: Queue;
  DEV_SIGNING_KEY: string;
  DASHBOARD_URL?: string;
  DEV_TOKEN_ISSUER?: string;
  RATE_LIMITER: RateLimit;
  ADMIN_API: Pick<AdminControl, "request" | "readiness">;
}
