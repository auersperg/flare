import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { FlaredClient } from "./client.js";
import { FlaredError, stableJson, type FunctionRef } from "./protocol.js";

const ClientContext = createContext<FlaredClient | null>(null);

/** The application owns the client; the provider never creates or disposes it. */
export function FlaredProvider({
  client,
  children,
}: {
  client: FlaredClient;
  children: ReactNode;
}) {
  return createElement(ClientContext.Provider, { value: client }, children);
}
export function useFlared(): FlaredClient {
  const client = useContext(ClientContext);
  if (!client)
    throw new FlaredError(
      "MISSING_PROVIDER",
      "Wrap your app in FlaredProvider",
    );
  return client;
}

/** Initial snapshot and updates in one subscription. Undefined means loading/skipped. */
export function useQuery<I, O>(
  ref: FunctionRef<I, O>,
  args: I | "skip",
): O | undefined {
  const client = useFlared();
  if (ref.kind !== "query")
    throw new FlaredError("INVALID_KIND", "useQuery requires a query");
  const key = args === "skip" ? undefined : stableJson(args);
  const stableArgs = useMemo(
    () => (key === undefined ? undefined : (JSON.parse(key) as I)),
    [key],
  );
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
    if (key === undefined) return;
    return client.onUpdate(
      ref,
      stableArgs as I,
      (value) => setState({ identity, value }),
      (error) => {
        // The transport reconnects automatically. Keep the last snapshot while reconnecting.
        if (["LIVE_DISCONNECTED", "LIVE_UNAVAILABLE"].includes(error.code))
          return;
        // No previous identity's data is displayed after logout or an authorization failure.
        setState({ identity, error });
      },
    );
  }, [client, ref.path, stableArgs, key, identity]);
  if (key === undefined || state.identity !== identity) return undefined;
  if (state.error) throw state.error;
  return state.value;
}
