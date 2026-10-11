import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import {
  createClient,
  FlaredError,
} from "../packages/flared/src/sdk/client.js";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const cli = fileURLToPath(
  new URL("../packages/flared/src/cli/main.mjs", import.meta.url),
);
describe("Flared product consistency", () => {
  it.each([
    ["flared", "flared"],
    ["core", "@flared/platform"],
  ])(
    "names the %s package consistently and guards unpublished previews",
    (folder, name) => {
      const pkg = JSON.parse(read(`packages/${folder}/package.json`));
      expect(pkg.name).toBe(name);
      expect(pkg.version).toBe(JSON.parse(read("package.json")).version);
      expect(pkg.license).toBe("UNLICENSED");
      expect(pkg.private).toBe(true);
    },
  );
  it("has exactly two top-level packages and one application dependency", () => {
    expect(existsSync(new URL("../packages/sdk", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../packages/cli", import.meta.url))).toBe(false);
    const pkg = JSON.parse(read("packages/flared/package.json"));
    expect(pkg.name).toBe("flared");
    expect(pkg.bin).toEqual({ flared: "./dist/cli/flared.js" });
    expect(pkg.files).toEqual(["dist", "README.md"]);
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.peerDependenciesMeta.react.optional).toBe(true);
    for (const name of Object.keys(pkg.dependencies))
      expect(name).not.toMatch(
        /agents|wrangler|workerd|vite|platform|dashboard|@flared/i,
      );
    for (const [key, entry] of [
      [".", "client"],
      ["./server", "server"],
      ["./react", "react"],
      ["./protocol", "protocol"],
      ["./cloudflare", "cloudflare"],
    ]) {
      expect(pkg.exports[key]).toEqual({
        types: `./dist/sdk/${entry}.d.ts`,
        import: `./dist/sdk/${entry}.js`,
      });
    }
    expect(read("packages/flared/src/sdk/client.ts")).not.toMatch(
      /from ["'][^"']*\/(?:cli|server|cloudflare)(?:\/|\.)/,
    );
    const build = read("scripts/build-packages.mjs");
    expect(build).not.toContain("await cp(");
    expect(build).toContain("packages/flared/src/cli/main.mjs");
  });
  it("generates application imports exclusively through the public flared package", () => {
    const build = read("packages/flared/src/cli/build.mjs");
    expect(build).toContain('import {reference} from "flared";');
    expect(build).toContain('from "flared/cloudflare"; export class');
    expect(read("packages/flared/src/cli/project.mjs")).toContain(
      'const source = `import {defineApp} from "flared/server";',
    );
  });
  it("help advertises only the cloud dashboard without loading the compiler", () => {
    const output = spawnSync(process.execPath, [cli, "--help"], {
      encoding: "utf8",
    });
    expect(output.status).toBe(0);
    expect(output.stdout).toContain("Flared 0.3");
    expect(output.stdout).toContain("Cloudflare-only");
    expect(output.stdout).toContain("flared build");
    expect(read("packages/flared/src/cli/main.mjs")).not.toMatch(
      /^import .*buildApplication/m,
    );
  });
  it.each([
    ["dashboard", "--local"],
    ["dev", "--local"],
    ["serve"],
    ["platform", "init"],
  ])(
    "does not start local tooling or pretend an unimplemented flow works: %s",
    (...parameters) => {
      const args: string[] = [];
      for (const arg of parameters) if (typeof arg === "string") args.push(arg);
      const output = spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
      });
      expect(output.status).toBe(1);
      expect(output.stderr).toContain(
        args[0] === "dev"
          ? "Expected supported unique named options"
          : "no deployment has occurred",
      );
    },
  );
  it("exports the Flared error identity", async () => {
    expect(new FlaredError("TEST", "test").name).toBe("FlaredError");
    const client = createClient({ url: "https://example.test" });
    client.dispose();
    await expect(
      client.query({ path: "test", kind: "query" }, {}),
    ).rejects.toBeInstanceOf(FlaredError);
  });
  it("the authoritative docs do not offer a second/local dashboard", () => {
    const docs = read("README.md");
    expect(docs).toContain("Cloudflare-hosted only");
    expect(docs).not.toMatch(
      /locally launched copy|optional local UI|reactive build|REACTIVE_KERNEL_URL/,
    );
    expect(JSON.parse(read("package.json")).name).toBe("flared-workspace");
  });
});

describe("Astro/shadcn dashboard", () => {
  it("has the requested primary sections including Auth", () => {
    const source = read("packages/core/dashboard/src/components/dashboard.tsx");
    const sections = source.slice(
      source.indexOf("export const sections"),
      source.indexOf("export type View"),
    );
    expect(
      [...sections.matchAll(/key:\s*["']([a-z]+)["']/g)].map((x) => x[1]),
    ).toEqual([
      "health",
      "data",
      "schema",
      "functions",
      "files",
      "schedules",
      "auth",
      "logs",
    ]);
    expect(source).toContain('label="Select project"');
    expect(source).toContain('aria-label="Select environment"');
    const authView = read(
      "packages/core/dashboard/src/components/auth-view.tsx",
    );
    expect(authView).toContain(
      'cursor ? "?cursor=" + encodeURIComponent(cursor) : ""',
    );
    expect(authView).not.toContain('"/auth-users?cursor="');
    expect(authView).toContain("Password must contain 6–128 characters");
    const forms = read("packages/core/dashboard/src/components/common.tsx");
    expect(forms).toContain(
      'minLength={f.type === "password" ? 6 : undefined}',
    );
    expect(forms).toContain(
      'maxLength={f.type === "password" ? 128 : undefined}',
    );
  });
  it("shows releases inline only for the selected environment without standalone Refresh", () => {
    const releases = read(
      "packages/core/dashboard/src/components/releases-panel.tsx",
    );
    expect(releases).toContain('"Development releases"');
    expect(releases).toContain('"Production releases"');
    expect(releases).toContain("scopePath(scope.project, scope.env)");
    expect(releases).not.toMatch(
      /Manage releases|Close releases|setSource|setOpen/,
    );
    for (const file of ["releases-panel", "backups-panel"])
      expect(
        read(`packages/core/dashboard/src/components/${file}.tsx`),
      ).not.toMatch(/>\s*Refresh\s*</);
  });
  it("uses the shared warmer Convex-reference dark surfaces", () => {
    const css = read("packages/core/dashboard/src/styles/global.css");
    const dark = css.slice(css.indexOf(".dark {"), css.indexOf("@layer base"));
    expect(dark).toContain("--background: #1d1c1a;");
    expect(dark).toContain("--card: #292825;");
    expect(dark).toContain("--sidebar: #292825;");
    expect(dark).toContain("--border: #44423f;");
  });
  it("uses the supplied real preset and local fonts", () => {
    const config = JSON.parse(read("packages/core/dashboard/components.json"));
    expect(config.style).toBe("base-lyra");
    expect(config.tailwind.baseColor).toBe("stone");
    expect(config.iconLibrary).toBe("lucide");
    const css = read("packages/core/dashboard/src/styles/global.css");
    expect(css).toContain("@fontsource-variable/geist");
    expect(css).toContain('@import "shadcn/tailwind.css"');
    expect(css).not.toMatch(/https:\/\//);
    expect(
      read("packages/core/dashboard/src/components/ui/button.tsx"),
    ).toContain("@base-ui/react/button");
    expect(
      read("packages/core/dashboard/src/components/ui/table.tsx"),
    ).toContain('data-slot="table"');
  });
  it("uses static Astro with a client-only dashboard and split views", () => {
    expect(read("packages/core/dashboard/astro.config.mjs")).toMatch(
      /output:\s*["']static["']/,
    );
    expect(read("packages/core/dashboard/src/pages/index.astro")).toContain(
      'client:only="react"',
    );
    expect(
      read("packages/core/dashboard/src/components/dashboard.tsx"),
    ).toMatch(/lazy\(\(\) => import\(["']\.\/data-view["']\)\)/);
    expect(read("scripts/build-platform.mjs")).toContain("build:dashboard");
  });
  it("uses real storage, real jobs and no polling", () => {
    const services = read(
      "packages/core/dashboard/src/components/services-view.tsx",
    );
    expect(services).toContain("/file-upload");
    expect(services).toContain("/file-delete");
    expect(services).not.toContain("setInterval");
    expect(services).toMatch(/\+ ["']\/jobs["']/);
    expect(
      read("packages/core/dashboard/src/components/common.tsx"),
    ).not.toContain("setInterval");
    expect(read("packages/core/dashboard/src/components/common.tsx")).toContain(
      "abort.abort()",
    );
  });
  it("retains production/viewer guards and request scoping", () => {
    expect(
      read("packages/core/dashboard/src/components/functions-view.tsx"),
    ).toMatch(/env === ["']dev["']\s*&&\s*role !== ["']viewer["']/);
    expect(
      read("packages/core/dashboard/src/components/data-view.tsx"),
    ).toMatch(/expectedRevision:\s*page.revision/);
    expect(
      read("packages/core/dashboard/src/components/data-view.tsx"),
    ).toMatch(/productionId: env === ["']prod["'] \? project.id : undefined/);
    expect(
      read("packages/core/dashboard/src/components/dashboard.tsx"),
    ).toContain("key={`${project!.id}/${env}/${view}`}");
  });
});

describe("Dashboard delivery", () => {
  it("keeps authenticated hashed assets browser-cacheable and API/HTML uncached", () => {
    const admin = read("packages/core/src/admin.ts");
    expect(admin).toContain('u.pathname.startsWith("/_astro/")');
    expect(admin).toContain("private, max-age=31536000, immutable");
    expect(admin).toContain("private, no-store");
    expect(admin.indexOf("await actor(request")).toBeLessThan(
      admin.indexOf("await env.ASSETS.fetch(request)"),
    );
    expect(admin).not.toContain("unsafe-inline");
  });
  it("has no legacy HTML dashboard and packages a static Astro output", () => {
    const build = read("scripts/build-platform.mjs");
    expect(build).toContain("Astro did not emit a CSP");
    expect(build).not.toContain("dashboard/main.ts");
    expect(
      read("packages/core/dashboard/src/components/dashboard.tsx"),
    ).not.toContain("innerHTML");
  });
});

describe("Production-only repository", () => {
  it("keeps formatting in the manifest and no duplicate product/config files at root", () => {
    expect(JSON.parse(read("package.json")).prettier).toEqual({
      plugins: ["prettier-plugin-astro"],
    });
    for (const file of [
      "flared.product.json",
      ".prettierrc.json",
      "admin.wrangler.json",
      "runtime.wrangler.json",
      "admin.wrangler.example.json",
      "runtime.wrangler.example.json",
    ])
      expect(existsSync(new URL(`../${file}`, import.meta.url))).toBe(false);
    const setup = read("scripts/setup-cloud.mjs");
    expect(setup).toContain('".private/cloudflare/admin.wrangler.json"');
    expect(setup).toContain('".private/cloudflare/runtime.wrangler.json"');
  });
  it("keeps canonical repository metadata and publication guards", () => {
    for (const path of [
      "package.json",
      "packages/core/package.json",
      "packages/flared/package.json",
      "packages/core/dashboard/package.json",
    ]) {
      const pkg = JSON.parse(read(path));
      expect(pkg.repository.url).toBe(
        "https://github.com/auersperg/flared.git",
      );
      expect(pkg.private).toBe(true);
      expect(pkg.license).toBe("UNLICENSED");
    }
  });
  it("commits portable examples rather than operator configuration", () => {
    const ignore = read(".gitignore");
    for (const path of [
      "/tests/kernel/wrangler.cloud.json",
      ".private/",
      ".dev.vars*",
      ".env*",
    ])
      expect(ignore.split("\n")).toContain(path);
    for (const role of ["admin", "runtime"]) {
      const config = JSON.parse(
        read(`packages/core/${role}.wrangler.example.json`),
      );
      expect(config.account_id).toBe("YOUR_CLOUDFLARE_ACCOUNT_ID");
      expect(config.vars.RUNTIME_URL).toBe("https://api.example.com");
      const example = new URL(
        `../packages/core/${role}.wrangler.example.json`,
        import.meta.url,
      );
      const operator = new URL(
        `../.private/cloudflare/${role}.wrangler.json`,
        import.meta.url,
      );
      const entry = new URL(`../packages/core/dist/${role}.js`, import.meta.url)
        .href;
      expect(new URL(config.main, example).href).toBe(entry);
      expect(new URL(config.main, operator).href).toBe(entry);
      if (role === "admin") {
        expect(new URL(config.assets.directory + "/", operator).href).toBe(
          new URL("../packages/core/dist/dashboard/", import.meta.url).href,
        );
        expect(
          new URL(config.d1_databases[0].migrations_dir + "/", operator).href,
        ).toBe(new URL("../packages/core/migrations/", import.meta.url).href);
      }
    }
    expect(
      JSON.parse(read("tests/kernel/wrangler.json")).account_id,
    ).toBeUndefined();
  });
  it("runs local checks in CI without automatic cloud deployments", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("bun run verify");
    expect(workflow).toContain("bun run test:kernel");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toMatch(
      /secrets\.|wrangler deploy|npm publish|test:cloud/,
    );
  });
  it("has no demo workspaces or build-time demo dependencies", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.workspaces).toEqual([
      "packages/flared",
      "packages/core",
      "packages/core/dashboard",
    ]);
    expect(pkg.scripts.dev).toBeUndefined();
    expect(pkg.scripts["build:demo"]).toBeUndefined();
    for (const name of ["apps", "examples"])
      expect(existsSync(new URL(`../${name}`, import.meta.url))).toBe(false);
    const build = read("scripts/build-platform.mjs");
    expect(build).not.toMatch(/examples\/|apps\//);
    expect(build).toContain("packages/core/bootstrap/app.ts");
  });
  it("new project bootstrap has no demonstration schema or functions", () => {
    expect(read("packages/core/bootstrap/app.ts")).toContain(
      "defineApp({ schema: {}, functions: {} })",
    );
    expect(read("packages/core/src/admin.ts")).toContain(
      '"https://assets.internal/bootstrap/"',
    );
  });
  it("cleaning preserves operator credentials and installed dependencies", () => {
    const clean = read("scripts/clean.mjs");
    expect(clean).toContain('"packages/core/dist"');
    expect(clean).toContain('"packages/flared/dist"');
    expect(clean).not.toMatch(/rm\([^\n]*\.private|rm\([^\n]*node_modules/);
    expect(clean).not.toMatch(/fetch\(|child_process/);
  });
});
