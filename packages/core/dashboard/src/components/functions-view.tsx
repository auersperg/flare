import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { Search, Folder, Code, Play } from "lucide-react";
import { Button } from "./ui/button";
import { FunctionBadge } from "./function-badge";
import { StatusBadge } from "./status-badge";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import {
  useResource,
  Status,
  Empty,
  Fields,
  Value,
  readFields,
  ErrorNotice,
} from "./common";
import {
  api,
  message,
  scopePath,
  type Manifest,
  type FunctionDefinition,
} from "../lib/model";
import { contractFields } from "../lib/presentation";
import {
  createClient,
  reference,
  type FlaredClient,
} from "../../../../sdk/src/client";
import type { Scope } from "./dashboard";
export default function FunctionsView(scope: Scope) {
  const r = useResource<Manifest>(
    scopePath(scope.project, scope.env) + "/functions",
  );
  const [filter, setFilter] = useState(""),
    [selection, setSelection] = useState("");
  const entries = Object.entries(r.data?.functions ?? {}),
    active = entries.find(([path]) => path === selection) ?? entries[0];
  const groups = new Map<string, [string, FunctionDefinition][]>();
  entries
    .filter(([path]) => path.toLowerCase().includes(filter.toLowerCase()))
    .forEach((entry) => {
      const module = entry[0].includes("/")
        ? entry[0].slice(0, entry[0].lastIndexOf("/"))
        : "Functions";
      const items = groups.get(module) ?? [];
      items.push(entry);
      groups.set(module, items);
    });
  return (
    <div className="flex min-h-full">
      <section className="explorer-sidebar" aria-label="Deployed functions">
        <div className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <h1 className="page-title">Functions</h1>
            <span className="text-xs text-muted-foreground">
              {entries.length}
            </span>
          </div>
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Search functions"
              placeholder="Search functions…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </InputGroup>
        </div>
        <div className="space-y-2 px-2">
          {[...groups].map(([module, items]) => (
            <details key={module} open>
              <summary className="flex cursor-pointer items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                <Folder className="size-4" />
                {module}
              </summary>
              <div className="space-y-1">
                {items.map(([path, fn]) => (
                  <Button
                    key={path}
                    variant="ghost"
                    onClick={() => setSelection(path)}
                    className={`w-full justify-between ${active?.[0] === path ? "bg-accent" : ""}`}
                  >
                    <span className="truncate">{path.split("/").pop()}</span>
                    <FunctionBadge kind={fn.kind} />
                  </Button>
                ))}
              </div>
            </details>
          ))}
        </div>
        <p className="p-4 text-xs text-muted-foreground">
          Active release · {scope.env}
        </p>
      </section>
      <section className="min-w-0 flex-1">
        <Status {...r} />
        {active ? (
          <Runner key={active[0]} {...scope} path={active[0]} fn={active[1]} />
        ) : r.data ? (
          <Empty title="No deployed functions" />
        ) : null}
      </section>
    </div>
  );
}
export function canRun(env: string, role: string, kind: string) {
  return (
    env === "dev" &&
    role !== "viewer" &&
    ["query", "mutation", "action"].includes(kind)
  );
}
function Runner({
  project,
  env,
  session,
  path,
  fn,
}: Scope & { path: string; fn: FunctionDefinition }) {
  const fields = contractFields(fn.input),
    allowed = canRun(env, session.role, fn.kind) && fn.auth !== "internal";
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(""),
    [result, setResult] = useState<unknown>(),
    [executed, setExecuted] = useState(false),
    [elapsed, setElapsed] = useState<number>();
  const alive = useRef(true),
    client = useRef<FlaredClient>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      client.current?.dispose();
    };
  }, []);
  const run = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!allowed || busy) return;
    setBusy(true);
    setFailure("");
    setElapsed(undefined);
    setResult(undefined);
    setExecuted(false);
    try {
      const input = readFields(e.currentTarget, fields);
      const info = await api<{ url: string; token: string }>(
        scopePath(project, env) + "/dev-token",
        {},
      );
      if (!alive.current) return;
      client.current = createClient({
        url: info.url,
        getToken: () => info.token,
      });
      const started = performance.now(),
        value = await client.current[fn.kind](reference(path, fn.kind), input);
      if (alive.current) {
        setResult(value);
        setExecuted(true);
        setElapsed(Math.round(performance.now() - started));
      }
    } catch (e) {
      if (alive.current) setFailure(message(e));
    } finally {
      client.current?.dispose();
      if (alive.current) setBusy(false);
    }
  };
  return (
    <>
      <div className="detail-header">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-mono text-sm font-semibold">{path}</h2>
          <FunctionBadge kind={fn.kind} />
          <StatusBadge status={fn.auth}>
            {fn.auth === "required" ? "Authentication required" : fn.auth}
          </StatusBadge>
        </div>
        <Button type="submit" form="function-run" disabled={!allowed || busy}>
          <Play />
          {busy ? "Running…" : "Run Function"}
        </Button>
      </div>
      <Tabs defaultValue="runner">
        <TabsList variant="line" className="mx-4 mt-4">
          <TabsTrigger value="runner">Function runner</TabsTrigger>
          <TabsTrigger value="contract">Contract</TabsTrigger>
        </TabsList>
        <TabsContent value="runner" className="mt-4">
          <div className="grid lg:grid-cols-2">
            <section className="space-y-4 border-b p-4 lg:border-r lg:border-b-0">
              <div className="flex justify-between">
                <h3 className="text-sm font-medium">Arguments</h3>
                <span className="text-xs text-muted-foreground">
                  {fields.length} fields
                </span>
              </div>
              <form id="function-run" onSubmit={run}>
                <Fields items={fields} />
              </form>
              <p className="text-xs text-muted-foreground">
                Development execution only. Mutations and actions can change
                data. Live subscriptions use the SDK. Writes are not
                automatically retried. Internal functions are called only by
                server capabilities or scheduled jobs, not this HTTP runner.
              </p>
            </section>
            <section className="space-y-4 p-4">
              <div className="flex justify-between">
                <h3 className="text-sm font-medium">Result</h3>
                <span className="text-xs text-muted-foreground">
                  {busy
                    ? "Running…"
                    : failure
                      ? "Failed"
                      : elapsed !== undefined
                        ? `Completed · ${elapsed} ms round trip`
                        : "Not executed"}
                </span>
              </div>
              {failure ? (
                <ErrorNotice>{failure}</ErrorNotice>
              ) : executed ? (
                <Value value={result} />
              ) : (
                <Empty title="Run this function to see its result">
                  <Code className="mx-auto mt-3 size-7" />
                </Empty>
              )}
            </section>
          </div>
        </TabsContent>
        <TabsContent value="contract" className="space-y-4 p-4">
          <section className="space-y-3">
            <h3 className="text-sm font-medium">Input contract</h3>
            <Value value={fn.input} />
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-medium">Output contract</h3>
            <Value value={fn.output} />
          </section>
        </TabsContent>
      </Tabs>
    </>
  );
}
