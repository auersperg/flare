// Types only: callers cannot pull Worker/DO implementations into their bundles.
// Wire names and RpcResult remain stable across sequential core updates.
import type { EnvironmentSupervisor, RuntimeControl } from "./runtime.js";
import type { Oidc, RpcResult } from "./security.js";

export type ScopeConfig = {
  scope: string;
  origins: string[];
  oidc: Oidc | null;
};

export type RuntimeApi = Pick<
  RuntimeControl,
  | "configure"
  | "deploy"
  | "admin"
  | "devIdentity"
  | "publishAlias"
  | "destroy"
  | "prepareDestroy"
  | "readiness"
>;

export type SupervisorApi = Pick<
  EnvironmentSupervisor,
  | "authCommand"
  | "application"
  | "socketIdentity"
  | "configuration"
  | "configure"
  | "publish"
  | "activate"
  | "admin"
  | "authenticate"
  | "consumeTicket"
  | "ticket"
  | "call"
  | "job"
  | "destroy"
  | "prepareDestroy"
  | "fileCommand"
  | "scheduleCommand"
>;

export type RpcArgs<Api, Operation extends keyof Api> = Api[Operation] extends (
  ...args: infer Args
) => unknown
  ? Args
  : never;
export type RpcValue<
  Api,
  Operation extends keyof Api,
> = Api[Operation] extends (...args: infer _Args) => infer Value
  ? Awaited<Value>
  : never;

export interface RuntimeBinding {
  fetch(request: Request): Promise<Response>;
  command<Operation extends keyof RuntimeApi>(
    operation: Operation,
    args: RpcArgs<RuntimeApi, Operation>,
  ): Promise<RpcResult<RpcValue<RuntimeApi, Operation>>>;
}

export interface SupervisorBinding {
  dispatch<Operation extends keyof SupervisorApi>(
    operation: Operation,
    args: RpcArgs<SupervisorApi, Operation>,
  ): Promise<RpcResult<RpcValue<SupervisorApi, Operation>>>;
  fetch(request: Request): Promise<Response>;
}
