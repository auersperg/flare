import { useEffect, useState } from "react";
import { createClient, reference } from "@auersperg/flare";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Status, useResource } from "./common";
import { api, message, scopePath } from "../lib/model";
import type { Scope } from "./dashboard";

type AiState = {
  search: {
    binding: string | null;
    remaining: number;
    errors: number;
    states: { status: string; count: number }[];
  };
  endpoint: string;
  auth: string;
  tools: { name: string; description: string }[];
};

export default function AiView({ project, env, session }: Scope) {
  const path = scopePath(project, env),
    r = useResource<AiState>(path + "/ai");
  const [token, setToken] = useState(""),
    [action, setAction] = useState(""),
    [args, setArgs] = useState('{"query":""}');
  const [output, setOutput] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setToken("");
    setOutput("");
    setError("");
  }, [path]);
  async function test() {
    setBusy(true);
    setError("");
    setOutput("");
    const client = createClient({
      url: `${session.runtime}/p/${project.id}/${env}`,
      getToken: () => token,
    });
    try {
      const value = await client.action(
        reference(action, "action"),
        JSON.parse(args),
      );
      setOutput(JSON.stringify(value, null, 2));
    } catch (e) {
      setError(message(e));
    } finally {
      client.dispose();
      setBusy(false);
    }
  }
  async function clear() {
    if (
      !confirm(
        `Exclude all indexed files in ${project.name}/${env}? Originals remain in Files. Provider cleanup is asynchronous.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(
        path + "/search-clear",
        env === "prod" ? { confirm: project.id } : {},
      );
      r.refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="page-title">AI</h1>
        <Button variant="outline" onClick={r.refresh}>
          Refresh
        </Button>
      </div>
      <Status loading={r.loading} error={r.error || error} />
      {r.data && (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Search</h2>
            <p>
              {r.data.search.binding
                ? `Binding: ${r.data.search.binding}`
                : "Not connected. Configure an existing AI Search instance through platform update --config. No resource is created here."}
            </p>
            <p className="text-sm text-muted-foreground">
              TXT/PDF · up to 10 MiB · explicit file indexing from application
              actions. File permissions belong to your application.
            </p>
            <p>Tracked index items: {r.data.search.remaining}</p>
            {r.data.search.states.map((s) => (
              <p key={s.status}>
                {s.status}: {s.count}
              </p>
            ))}
            {r.data.search.errors > 0 && (
              <p role="alert">
                {r.data.search.errors} operations need attention. Retry indexing
                through the application; retry pending cleanup with Exclude all.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Processing states are last observed, not a live provider status.
              Use action search.status(fileId) to refresh a document. Files,
              Functions and Logs remain in their existing sections.
            </p>
            {session.role !== "viewer" && r.data.search.remaining > 0 && (
              <Button variant="outline" disabled={busy} onClick={clear}>
                Exclude all / retry cleanup
              </Button>
            )}
          </section>
          <section className="space-y-3">
            <h2 className="text-lg font-medium">Test application search</h2>
            <p className="text-sm text-muted-foreground">
              Calls your existing search action with a real application session,
              not dashboard/admin identity. The application must authorize each
              result. Session is held only in this view, never saved. Dashboard
              origin must be allowed by the application.
            </p>
            <label className="block">
              Application session
              <Input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="flared_session_…"
              />
            </label>
            <label className="block">
              Search action path
              <Input
                value={action}
                onChange={(e) => setAction(e.target.value)}
                placeholder="documents/search"
              />
            </label>
            <label className="block">
              Arguments (JSON)
              <Textarea
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </label>
            <Button
              disabled={
                busy ||
                !token.startsWith("flared_session_") ||
                !action ||
                !r.data.search.binding
              }
              onClick={test}
            >
              Run once
            </Button>
            {output && (
              <pre className="whitespace-pre-wrap break-words text-sm">
                {output}
              </pre>
            )}
          </section>
          <section className="space-y-3">
            <h2 className="text-lg font-medium">MCP</h2>
            <code className="break-all">{r.data.endpoint}</code>
            <p className="text-sm text-muted-foreground">
              Stateless HTTP. Use a client supporting an Authorization: Bearer
              application-session header. No OAuth discovery. Admin, deploy and
              dev tokens are not accepted. Logout, expiry and disabling the user
              revoke access.
            </p>
            {r.data.tools.length ? (
              r.data.tools.map((tool) => (
                <p key={tool.name}>
                  <strong>{tool.name}</strong> — {tool.description}
                </p>
              ))
            ) : (
              <p>
                No tools exposed. Add explicit mcp metadata to selected
                application functions and deploy that application.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
