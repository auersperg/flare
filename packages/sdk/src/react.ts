import { useEffect, useMemo, useState } from "react";
import type { FlaredClient } from "./client.js";
import { stableJson, type FunctionRef, type FlaredError } from "./protocol.js";
export function useLive<I, O>(
  client: FlaredClient,
  ref: FunctionRef<I, O>,
  args: I,
) {
  const key = stableJson(args);
  const stableArgs = useMemo(() => JSON.parse(key) as I, [key]);
  const identity = useMemo(
    () => ({ client, path: ref.path, args: key }),
    [client, ref.path, key],
  );
  const [state, setState] = useState<{
    identity: typeof identity;
    value?: O;
    error?: FlaredError;
  }>({ identity });
  useEffect(() => {
    setState({ identity });
    return client.subscribe(ref, stableArgs, {
      next: (value) => setState({ identity, value }),
      error: (error) =>
        setState((previous) =>
          [
            "AUTH_CHANGED",
            "AUTH_EXPIRED",
            "UNAUTHORIZED",
            "FORBIDDEN",
            "HTTP_401",
            "HTTP_403",
          ].includes(error.code)
            ? { identity, error }
            : { ...previous, identity, error },
        ),
    });
  }, [client, ref.path, ref.kind, stableArgs, identity]);
  return state.identity === identity
    ? {
        value: state.value,
        error: state.error,
        loading: state.value === undefined,
      }
    : { value: undefined, error: undefined, loading: true };
}
