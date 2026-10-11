import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { expect, it } from "bun:test";
import { collectCatalog } from "../packages/core/src/retention";
function fixture() {
  const db = new Database(":memory:");
  for (const name of ["0001.sql", "0003_cli_login.sql", "0004_retention.sql"])
    db.exec(
      readFileSync(
        new URL(`../packages/core/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  let writes = 0;
  const catalog = {
    prepare(sql: string) {
      let args: any[] = [];
      const query = {
        bind(...values: any[]) {
          args = values;
          return query;
        },
        async first() {
          writes++;
          return db.prepare(sql).get(...args) ?? null;
        },
        async run() {
          writes++;
          return {
            meta: { changes: Number(db.prepare(sql).run(...args).changes) },
          };
        },
      };
      return query;
    },
    async batch(statements: any[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    db,
    catalog: catalog as unknown as D1Database,
    writes: () => writes,
  };
}
it("collects bounded expired catalog history on writes only, keeping recent audits and live credentials", async () => {
  const { db, catalog, writes } = fixture(),
    now = 1800000000000;
  db.exec(
    "INSERT INTO customers VALUES ('c','Customer',0); INSERT INTO projects VALUES ('p','c','Project',0)",
  );
  db.prepare("INSERT INTO credentials VALUES ('expired','p','owner',?,0)").run(
    now - 15 * 86400000,
  );
  db.prepare("INSERT INTO credentials VALUES ('active','p','owner',?,0)").run(
    now + 86400000,
  );
  for (let i = 0; i < 1001; i++)
    db.prepare(
      "INSERT INTO audit VALUES (?,?,'owner','p','dev','edit','ok','{}')",
    ).run(String(i), now - 91 * 86400000);
  db.prepare(
    "INSERT INTO audit VALUES ('new',?,'owner','p','dev','edit','ok','{}')",
  ).run(now);
  await collectCatalog(catalog, now);
  expect(db.prepare("SELECT count(*) n FROM audit").get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT hash FROM credentials").all()).toEqual([
    { hash: "active" },
  ]);
  const before = writes();
  await collectCatalog(catalog, now + 1000);
  expect(writes()).toBe(before);
  await collectCatalog(catalog, now + 60001);
  expect(db.prepare("SELECT id FROM audit").all()).toEqual([{ id: "new" }]);
  db.close();
});
it("respects another isolate's durable catalog sweep lease", async () => {
  const { db, catalog, writes } = fixture(),
    now = 1800000000000;
  db.prepare("UPDATE maintenance SET next=?").run(now + 86400000);
  await collectCatalog(catalog, now);
  expect(writes()).toBe(1);
  await collectCatalog(catalog, now + 1000);
  expect(writes()).toBe(1);
  db.close();
});
