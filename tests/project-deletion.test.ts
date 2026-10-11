import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import {
  authorizeProjectDeletion,
  deleteProject,
} from "../packages/core/src/project-deletion";

const id = "443eb045-22b8-4c1e-bfee-1eaf7b01a0f9";
const other = "443eb045-22b8-4c1e-bfee-1eaf7b01a0f8";
function fixture() {
  const db = new Database(":memory:");
  const migrations = new URL("../packages/core/migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(file, migrations), "utf8"));
  db.exec("INSERT INTO customers VALUES ('c','Customer',0)");
  for (const project of [id, other]) {
    db.prepare("INSERT INTO projects VALUES (?,'c','Test',0)").run(project);
    db.prepare("INSERT INTO project_aliases VALUES (?,?,1)").run(
      project,
      "app-" + project.slice(-1),
    );
    db.prepare(
      "INSERT INTO credentials VALUES (?,?,'owner',9999999999999,0)",
    ).run(project, project);
    for (const env of ["dev", "prod"])
      db.prepare("INSERT INTO environments(projectId,env) VALUES (?,?)").run(
        project,
        env,
      );
  }
  const catalog = {
    prepare(sql: string) {
      let args: any[] = [];
      const query = {
        bind(...values: any[]) {
          args = values;
          return query;
        },
        async run() {
          return { meta: { changes: db.prepare(sql).run(...args).changes } };
        },
      };
      return query;
    },
    async batch(statements: any[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db, catalog: catalog as unknown as D1Database };
}
describe("owner project deletion", () => {
  it("migrates existing aliases without losing reservations or keeping a project FK", () => {
    const db = new Database(":memory:");
    const folder = new URL("../packages/core/migrations/", import.meta.url);
    for (const file of ["0001.sql", "0002_project_aliases.sql"])
      db.exec(readFileSync(new URL(file, folder), "utf8"));
    db.exec("INSERT INTO customers VALUES ('c','Customer',0)");
    db.prepare("INSERT INTO projects VALUES (?,'c','Test',0)").run(id);
    db.prepare("INSERT INTO project_aliases VALUES (?,'test',1)").run(id);
    db.exec(readFileSync(new URL("0005_project_deletion.sql", folder), "utf8"));
    expect(db.prepare("SELECT * FROM project_aliases").all()).toEqual([
      { projectId: id, alias: "test", published: 1 },
    ]);
    db.prepare("DELETE FROM projects WHERE id=?").run(id);
    expect(db.prepare("SELECT alias FROM project_aliases").all()).toEqual([
      { alias: "test" },
    ]);
    db.close();
  });
  it.each(["viewer", "editor"])("denies %s before deleting anything", (role) =>
    expect(() =>
      authorizeProjectDeletion(
        { role, projectId: null },
        { id, name: "Test" },
        { confirm: id, name: "Test" },
      ),
    ).toThrow("FORBIDDEN"),
  );
  it("denies scoped CLI credentials even for an owner", () =>
    expect(() =>
      authorizeProjectDeletion(
        { role: "owner", projectId: id },
        { id, name: "Test" },
        { confirm: id, name: "Test" },
      ),
    ).toThrow("FORBIDDEN"));
  it.each([
    { name: "test", confirm: id },
    { name: "Test ", confirm: id },
    { name: "Test", confirm: other },
    {},
  ])("requires exact name and immutable ID: %j", (input) =>
    expect(() =>
      authorizeProjectDeletion(
        { role: "owner", projectId: null },
        { id, name: "Test" },
        input,
      ),
    ).toThrow("INVALID_CONFIRMATION"),
  );
  it("accepts the exact owner confirmation", () =>
    expect(() =>
      authorizeProjectDeletion(
        { role: "owner", projectId: null },
        { id, name: "Test" },
        { name: "Test", confirm: id },
      ),
    ).not.toThrow());
  it("erases both environments, revokes credentials, retains audit/URL reservation and leaves other projects untouched", async () => {
    const { db, catalog } = fixture();
    db.prepare(
      "INSERT INTO audit VALUES ('a',0,'owner',?,'dev','write','ok','{}')",
    ).run(id);
    const calls: string[] = [];
    const runtime = {
      async prepareDestroy(scope: string) {
        calls.push("fence:" + scope);
      },
      async destroy(scope: string) {
        expect(
          db
            .prepare(
              "SELECT projectId FROM project_deletions WHERE projectId=?",
            )
            .get(id),
        ).toBeTruthy();
        expect(
          db
            .prepare("SELECT revoked FROM credentials WHERE projectId=?")
            .get(id),
        ).toEqual({ revoked: 1 });
        calls.push(scope);
      },
    };
    expect(await deleteProject(catalog, runtime, id)).toEqual({
      deleted: true,
      id,
    });
    expect(calls).toEqual([
      "fence:" + id + "/dev",
      "fence:" + id + "/prod",
      id + "/dev",
      id + "/prod",
    ]);
    for (const table of ["projects", "environments", "credentials"])
      expect(
        db
          .prepare(
            `SELECT COUNT(*) n FROM ${table} WHERE ${table === "projects" ? "id" : "projectId"}=?`,
          )
          .get(id),
      ).toEqual({ n: 0 });
    expect(db.prepare("SELECT id FROM projects").all()).toEqual([
      { id: other },
    ]);
    expect(
      db
        .prepare("SELECT published FROM project_aliases WHERE projectId=?")
        .get(id),
    ).toEqual({ published: 0 });
    expect(db.prepare("SELECT id FROM audit").all()).toEqual([{ id: "a" }]);
    expect(
      db
        .prepare("SELECT revoked FROM credentials WHERE projectId=?")
        .get(other),
    ).toEqual({ revoked: 0 });
    expect(() =>
      db
        .prepare("INSERT INTO project_aliases VALUES (?,'app-9',1)")
        .run(crypto.randomUUID()),
    ).toThrow();
    db.close();
  });
  it("persists a closed project on partial failure and safely retries completed environment cleanup", async () => {
    const { db, catalog } = fixture();
    let failing = true;
    const calls: string[] = [];
    const runtime = {
      async prepareDestroy() {},
      async destroy(scope: string) {
        calls.push(scope);
        if (scope.endsWith("/prod") && failing) throw Error("R2 unavailable");
      },
    };
    await expect(deleteProject(catalog, runtime, id)).rejects.toThrow(
      "R2 unavailable",
    );
    expect(
      db.prepare("SELECT id FROM projects WHERE id=?").get(id),
    ).toBeTruthy();
    expect(
      db
        .prepare("SELECT projectId FROM project_deletions WHERE projectId=?")
        .get(id),
    ).toBeTruthy();
    expect(
      db.prepare("SELECT revoked FROM credentials WHERE projectId=?").get(id),
    ).toEqual({ revoked: 1 });
    failing = false;
    await deleteProject(catalog, runtime, id);
    expect(calls).toEqual([
      id + "/dev",
      id + "/prod",
      id + "/dev",
      id + "/prod",
    ]);
    expect(db.prepare("SELECT id FROM projects WHERE id=?").get(id)).toBeNull();
    db.close();
  });
  it("rolls back catalog finalization if it fails after physical cleanup", async () => {
    const { db, catalog } = fixture();
    db.exec(
      "CREATE TRIGGER fail_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(FAIL,'catalog failure'); END",
    );
    await expect(
      deleteProject(
        catalog,
        { async prepareDestroy() {}, async destroy() {} },
        id,
      ),
    ).rejects.toThrow("catalog failure");
    expect(
      db
        .prepare("SELECT COUNT(*) n FROM environments WHERE projectId=?")
        .get(id),
    ).toEqual({ n: 2 });
    expect(
      db.prepare("SELECT revoked FROM credentials WHERE projectId=?").get(id),
    ).toEqual({ revoked: 1 });
    db.exec("DROP TRIGGER fail_delete");
    await deleteProject(
      catalog,
      { async prepareDestroy() {}, async destroy() {} },
      id,
    );
    expect(db.prepare("SELECT id FROM projects WHERE id=?").get(id)).toBeNull();
    db.close();
  });
});
