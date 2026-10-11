import { boundedJson, FlareError } from "../../flare/src/sdk/protocol.js";

export type AppPolicy = { outbound: string[]; secrets: Record<string, string> };
export type PolicyEnv = { APP_CAPABILITIES?: string };
const empty: AppPolicy = { outbound: [], secrets: {} };
const policies = new WeakMap<object, Record<string, AppPolicy>>();

/** Operator configuration, not an application-supplied binding or an account API credential. */
export function appPolicy(env: PolicyEnv, scope: string): AppPolicy {
  let cached = policies.get(env);
  if (!cached) {
    const raw = JSON.parse(env.APP_CAPABILITIES ?? "{}");
    boundedJson(raw, 16384);
    if (!raw || Array.isArray(raw) || typeof raw !== "object")
      throw new FlareError("INVALID_CONFIG", "Invalid app capabilities");
    cached = Object.create(null);
    for (const [key, value] of Object.entries(raw) as [string, any][]) {
      if (
        !/^[0-9a-f-]{36}\/(dev|prod)$/.test(key) ||
        !value ||
        Object.keys(value).some((k) => !["outbound", "secrets"].includes(k))
      )
        throw new FlareError("INVALID_CONFIG", "Invalid capability scope");
      const outbound = value.outbound ?? [],
        secrets = value.secrets ?? {};
      if (
        !Array.isArray(outbound) ||
        outbound.length > 20 ||
        !secrets ||
        Array.isArray(secrets) ||
        typeof secrets !== "object" ||
        Object.keys(secrets).length > 16
      )
        throw new FlareError("INVALID_CONFIG", "Capability limits exceeded");
      for (const host of outbound)
        if (
          typeof host !== "string" ||
          host.length > 253 ||
          !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
          host.endsWith(".localhost") ||
          host.endsWith(".local") ||
          host.endsWith(".internal")
        )
          throw new FlareError(
            "INVALID_CONFIG",
            "Only exact public HTTPS hostnames are allowed",
          );
      for (const [name, binding] of Object.entries(secrets))
        if (
          !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) ||
          typeof binding !== "string" ||
          !/^APP_SECRET_[A-Z0-9_]{1,64}$/.test(binding)
        )
          throw new FlareError(
            "INVALID_CONFIG",
            "Only app secret bindings are allowed",
          );
      cached![key] = Object.freeze({
        outbound: Object.freeze([...new Set(outbound)]) as unknown as string[],
        secrets: Object.freeze({ ...secrets }),
      });
    }
    policies.set(env, cached!);
  }
  return cached![scope] ?? empty;
}

export async function appSecret(
  env: PolicyEnv,
  scope: string,
  name: string,
): Promise<string> {
  const mapping = appPolicy(env, scope).secrets;
  if (!Object.hasOwn(mapping, name))
    throw new FlareError(
      "SECRET_NOT_FOUND",
      "Secret is not granted to this environment",
    );
  const binding = (env as Record<string, unknown>)[mapping[name]] as
    SecretsStoreSecret | undefined;
  if (!binding || typeof binding.get !== "function")
    throw new FlareError(
      "SECRET_UNAVAILABLE",
      "Secrets Store binding is missing",
    );
  return binding.get();
}

const maxBytes = 1048576;
function limited(body: ReadableStream<Uint8Array> | null) {
  let bytes = 0;
  return (
    body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes)
            throw new FlareError("TOO_LARGE", "Outbound body exceeds 1 MiB");
          controller.enqueue(chunk);
        },
      }),
    ) ?? null
  );
}

/** Native globalOutbound gateway: HTTP only, no TCP, wildcards, implicit redirects or unbounded buffering. */
export async function outbound(
  request: Request,
  policy: AppPolicy,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !policy.outbound.includes(url.hostname)
  )
    throw new FlareError("OUTBOUND_DENIED", "Destination is not allowed");
  const length = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > maxBytes)
    throw new FlareError("TOO_LARGE", "Outbound request exceeds 1 MiB");
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()])
    if (
      name.toLowerCase().startsWith("cf-") ||
      ["host", "connection", "transfer-encoding", "content-length"].includes(
        name.toLowerCase(),
      )
    )
      headers.delete(name);
  const response = await fetch(url, {
    method: request.method,
    headers,
    body: limited(request.body),
    redirect: "manual",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new FlareError(
      "OUTBOUND_DENIED",
      "Redirects require an explicit allowed request",
    );
  }
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw new FlareError("TOO_LARGE", "Outbound response exceeds 1 MiB");
  }
  return new Response(limited(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
