import { accessSnapshot } from "./platform-config.mjs";
import { configurationDigest } from "./platform-state.mjs";

// Both status and update verification must check the same complete contract.
// Return field names only: diagnostics must never print response bodies/secrets.
export function runtimeReadinessFailures(
  data,
  state,
  release = state.installed,
) {
  const expected = {
    readiness: "control-plane-ready",
    installationId: state.id,
    platformPayload: release?.digest,
    version: release?.version,
    runtimeAbi: release?.runtimeAbi ?? 4,
    protocol: release?.protocol ?? 1,
  };
  return Object.keys(expected).filter(
    (key) => expected[key] === undefined || data?.[key] !== expected[key],
  );
}

/** Read-only, bounded probes. Checkpoints remain separate from live evidence. */
export async function platformHealth(cf, state, fetcher) {
  const checkedAt = Date.now();
  const probe = async (fn) => {
    try {
      return await fn();
    } catch {
      return { status: "unavailable" };
    }
  };
  const [runtime, dashboard, access] = await Promise.all([
    probe(async () => {
      const r = await fetcher(
        `https://${state.addresses.runtimeHost}/health?ready=1`,
        { redirect: "error", signal: AbortSignal.timeout(5000) },
      );
      if (!r.ok) {
        await r.body?.cancel();
        return { status: "unhealthy", httpStatus: r.status };
      }
      const d = await r.json();
      const mismatches = runtimeReadinessFailures(d, state);
      return {
        status: mismatches.length ? "mismatch" : "healthy",
        ...(mismatches.length ? { mismatches } : {}),
        version: d.version,
        installationId: d.installationId,
      };
    }),
    probe(async () => {
      const r = await fetcher(
        `https://${state.addresses.adminHost}/api/session`,
        { redirect: "manual", signal: AbortSignal.timeout(5000) },
      );
      const location = r.headers.get("location");
      await r.body?.cancel();
      const closed =
        [401, 403].includes(r.status) ||
        ([301, 302, 303, 307, 308].includes(r.status) &&
          location &&
          new URL(location, `https://${state.addresses.adminHost}`).origin ===
            state.access?.issuer);
      return {
        status: closed ? "access-protected" : "not-verified-closed",
        httpStatus: r.status,
        applicationHealth: "not-checked-without-owner-session",
      };
    }),
    probe(async () => {
      if (!state.access) return { status: "not-configured" };
      const { app, digest } = await accessSnapshot(cf, state.access.id);
      const host =
        app.domain === state.addresses.adminHost ||
        app.destinations?.some(
          (d) => d.type === "public" && d.uri === state.addresses.adminHost,
        );
      const matches =
        !state.access.snapshot ||
        (state.access.snapshotFormat === 2
          ? digest
          : configurationDigest(app)) === state.access.snapshot;
      return {
        status:
          host && app.aud === state.access.aud && matches
            ? "verified"
            : "drift",
        snapshot: digest,
        snapshotFormat: 2,
      };
    }),
  ]);
  return {
    status: state.operation
      ? "incomplete"
      : runtime.status === "healthy" &&
          dashboard.status === "access-protected" &&
          access.status === "verified"
        ? "ready"
        : "not-verified",
    checkedAt,
    runtime,
    dashboard,
    access,
  };
}
