export function connectDashboardLive(
  scope: string,
  changed: () => void,
  status: (
    value: "connecting" | "connected" | "disconnected" | "revoked",
  ) => void,
  createSocket = (url: string) => new WebSocket(url),
) {
  let stopped = false,
    socket: WebSocket | undefined,
    retry: ReturnType<typeof setTimeout> | undefined,
    pending: ReturnType<typeof setTimeout> | undefined,
    probe: AbortController | undefined,
    delay = 1000;
  const hint = () => {
    if (!pending)
      pending = setTimeout(() => {
        pending = undefined;
        if (!stopped) changed();
      }, 200);
  };
  const open = () => {
    if (stopped) return;
    status("connecting");
    const url = new URL(`/api/${scope}/live`, location.origin);
    url.protocol = "wss:";
    socket = createSocket(url.href);
    socket.onmessage = (e) => {
      if (stopped) return;
      try {
        const frame = JSON.parse(e.data);
        if (frame.type === "ready") {
          delay = 1000;
          status("connected");
          hint();
        }
        if (frame.type === "invalidate") hint();
      } catch {
        socket?.close(1002, "Invalid frame");
      }
    };
    socket.onclose = async (event) => {
      if (stopped) return;
      if (event.code === 1008 && event.reason !== "Expired") {
        stopped = true;
        clearTimeout(pending);
        pending = undefined;
        status("revoked");
        return;
      }
      status("disconnected");
      // A rejected HTTP upgrade hides 401/403 behind WebSocket code 1006.
      // Check authorization only after that event, not on an interval. A
      // transient network failure must not be mistaken for revocation.
      if (event.code === 1006) {
        probe = new AbortController();
        try {
          const r = await fetch(
            new URL(`/api/${scope}/health`, location.origin),
            {
              redirect: "manual",
              signal: AbortSignal.any([
                probe.signal,
                AbortSignal.timeout(5000),
              ]),
            },
          );
          await r.body?.cancel();
          if (
            [401, 403, 404].includes(r.status) ||
            r.type === "opaqueredirect"
          ) {
            if (!stopped) {
              stopped = true;
              clearTimeout(pending);
              status("revoked");
            }
            return;
          }
        } catch {
          /* Network/Access redirect is unavailable, not confirmed revoked. */
        }
        if (stopped) return;
      }
      retry = setTimeout(open, delay + Math.floor(Math.random() * 250));
      delay = Math.min(30000, delay * 2);
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(pending);
    probe?.abort();
    socket?.close();
  };
}
