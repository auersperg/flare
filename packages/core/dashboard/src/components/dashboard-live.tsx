import { createContext, useEffect, useState, type ReactNode } from "react";
import { connectDashboardLive } from "../lib/live";
export const DashboardInvalidation = createContext({ scope: "", epoch: 0 });
export function DashboardLive({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  const [epoch, setEpoch] = useState(0);
  const [status, setStatus] = useState("connecting");
  useEffect(
    () => connectDashboardLive(scope, () => setEpoch((v) => v + 1), setStatus),
    [scope],
  );
  return status === "revoked" ? (
    <p role="alert" className="p-4">
      Live access was revoked or could not be verified. Reload and sign in
      again.
    </p>
  ) : (
    <DashboardInvalidation.Provider value={{ scope, epoch }}>
      <span className="sr-only" role="status">
        Live updates: {status}
      </span>
      {status === "disconnected" && (
        <p role="status" className="px-4 text-xs text-muted-foreground">
          Live updates disconnected. Showing the last snapshot; reconnecting.
        </p>
      )}
      {children}
    </DashboardInvalidation.Provider>
  );
}
