import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { useResource, Status, ErrorNotice } from "./common";
import { api, message, scopePath, type Settings } from "../lib/model";
import type { Scope } from "./dashboard";

export default function SdkView({ project, env, session }: Scope) {
  const path = scopePath(project, env),
    r = useResource<Settings>(path + "/settings");
  const [identity, setIdentity] = useState<{ url: string; token: string }>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef<AbortController>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  const issueToken = async () => {
    if (busy || env !== "dev" || session.role === "viewer") return;
    const abort = new AbortController();
    pending.current = abort;
    setBusy(true);
    setError("");
    setIdentity(undefined);
    try {
      const result = await api<{ url: string; token: string }>(
        path + "/dev-token",
        {},
        abort.signal,
      );
      if (!abort.signal.aborted) setIdentity(result);
    } catch (e) {
      if (!abort.signal.aborted) setError(message(e));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="space-y-4 p-4">
      <h1 className="page-title">SDK · Live</h1>
      <p className="text-xs text-muted-foreground">
        One environment URL for browser, server and mobile clients. Use the
        generated API references from your application build.
      </p>
      <Status {...r} />
      {r.data && (
        <Card>
          <CardHeader>
            <CardTitle>Connect your application</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <pre className="code-block">{`import { createClient } from 'flare';\nimport { api } from './flare/_generated/api';\n\nconst client = createClient({\n  url: '${r.data.url}',\n  getToken: () => yourUserAccessToken,\n});\n\n// Use your generated query / mutation / action references.\n// Example: replace this path with your own query:\nconst stop = client.onUpdate(api.tasks.list, { limit: 50 },\n  tasks => console.log(tasks));\n\n// On logout: client.refreshAuth().\n// On teardown: stop(); client.dispose();`}</pre>
            <p className="text-muted-foreground">
              The task function is an illustrative name, not a requirement for
              other projects. Run your app locally to test live updates; this
              page opens no background subscription and does not write
              application data.
            </p>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            {env === "dev"
              ? "Local developer session"
              : "Production authentication"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground">
            {env === "dev"
              ? "A 15-minute identity for this project's development environment. Keep it in a git-ignored local file, never in a bundle or commit. Request a new token after expiry."
              : "Use an OIDC access token from your application's login provider. Developer identities cannot access production."}
          </p>
          {env === "dev" && session.role !== "viewer" && (
            <Button variant="outline" onClick={issueToken} disabled={busy}>
              <KeyRound />
              {busy ? "Requesting…" : "Get developer session"}
            </Button>
          )}
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {identity && (
            <>
              <pre className="code-block">
                {JSON.stringify(identity, null, 2)}
              </pre>
              <Button variant="ghost" onClick={() => setIdentity(undefined)}>
                Clear from view
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
