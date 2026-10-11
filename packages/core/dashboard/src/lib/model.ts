export type Environment = "dev" | "prod";
export type Session = {
  email: string;
  role: "owner" | "editor" | "viewer";
  runtime: string;
};
export type Project = {
  id: string;
  name: string;
  customer: string;
  alias?: string;
};
export type Column = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: unknown;
  schema?: Record<string, unknown>;
};
export type Schema = {
  tables: {
    name: string;
    columns: Column[];
    document: Record<string, unknown>;
    indexes: Record<string, string[]>;
  }[];
};
export type Row = Record<string, unknown>;
export type Page = {
  rows: Row[];
  columns: Column[];
  next: string | null;
  revision: number;
};
export type Settings = {
  url: string;
  alias?: string;
  origins: string[];
  oidc: null | { issuer: string; audience: string; jwks: string };
};
export type Health = {
  status: string;
  active?: string;
  connections: number;
  subscriptions: number;
};
export type FunctionDefinition = {
  kind: "query" | "mutation" | "action";
  auth: string;
  input: unknown;
  output: unknown;
};
export type Manifest = { functions: Record<string, FunctionDefinition> };
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    redirect: "error",
  });
  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json"))
    throw Error("Session expired. Sign in again through Cloudflare Access.");
  const data: unknown = await response.json();
  if (!response.ok)
    throw Error(
      data &&
        typeof data === "object" &&
        "error" in data &&
        typeof data.error === "string"
        ? data.error
        : `HTTP ${response.status}`,
    );
  return data as T;
}
export const scopePath = (project: Project, env: Environment) =>
  `projects/${project.id}/${env}`;
export function message(e: unknown) {
  return e instanceof Error ? e.message : "Request failed";
}
export function scalar(value: unknown) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `List · ${value.length}`;
  if (typeof value === "object") return "Object";
  return String(value).slice(0, 2000);
}
