import { WorkerEntrypoint } from "cloudflare:workers";
import {
  authorizationServer,
  handleRequest,
  type Env,
  type Identity,
} from "./handler.js";
export class McpAuthorization extends WorkerEntrypoint<Env> {
  validateToken(resource: string, token: string) {
    if (resource !== this.env.MCP_RESOURCE) return null;
    return authorizationServer(this.env).validateToken<Identity>(
      resource,
      token,
      this.env,
    );
  }
}
export default { fetch: handleRequest };
