import { createFacet } from "../../packages/sdk/src/cloudflare.js";
import { app } from "./sdk-app.js";
export class AppFacet extends createFacet(app, {
  journal: {
    entries: [{ idx: 0, when: 1000, tag: "0000_sdk", breakpoints: true }],
  },
  migrations: {
    m0000:
      "CREATE TABLE sdk_counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
  },
}) {
  async snapshot() {
    return this.execute({ path: "get", kind: "query", args: {}, auth: null });
  }
}
