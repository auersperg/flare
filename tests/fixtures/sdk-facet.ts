import { createFacet } from "../../packages/flare/src/sdk/cloudflare.js";
import { app } from "./sdk-app.js";
export class AppFacet extends createFacet(app) {
  async snapshot() {
    return {
      ...(await super.snapshot()),
      ...(await this.execute({
        path: "get",
        kind: "query",
        args: {},
        auth: null,
      })),
    };
  }
}
