import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { createClient, FlareError } from "../packages/flare/src/sdk/client.js";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const cli = fileURLToPath(
  new URL("../packages/flare/src/cli/main.mjs", import.meta.url),
);
describe("Flare product consistency", () => {
  it.each([
    ["flare", "@auersperg/flare"],
    ["core", "@flare/platform"],
  ])(
    "aligns the %s package name/version and publication boundary",
    (folder, name) => {
      const pkg = JSON.parse(read(`packages/${folder}/package.json`));
      expect(pkg.name).toBe(name);
      expect(pkg.version).toBe(JSON.parse(read("package.json")).version);
      expect(pkg.license).toBe("MIT");
      expect(pkg.private).toBe(folder === "core" ? true : undefined);
    },
  );
  it("has exactly two top-level packages and one application dependency", () => {
    expect(existsSync(new URL("../packages/sdk", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../packages/cli", import.meta.url))).toBe(false);
    const pkg = JSON.parse(read("packages/flare/package.json"));
    expect(pkg.name).toBe("@auersperg/flare");
    expect(pkg.bin).toEqual({ flare: "./dist/cli/flare.js" });
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.peerDependenciesMeta.react.optional).toBe(true);
    for (const name of Object.keys(pkg.dependencies))
      expect(name).not.toMatch(
        /agents|wrangler|workerd|vite|platform|dashboard|@flare/i,
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
    expect(read("packages/flare/src/sdk/client.ts")).not.toMatch(
      /from ["'][^"']*\/(?:cli|server|cloudflare)(?:\/|\.)/,
    );
    const build = read("scripts/build-packages.mjs");
    expect(build).not.toContain("await cp(");
    expect(build).toContain("packages/flare/src/cli/main.mjs");
  });
  it("generates application imports exclusively through the public flare package", () => {
    const build = read("packages/flare/src/cli/build.mjs");
    expect(build).toContain('import {reference} from "@auersperg/flare";');
    expect(build).toContain('from "@auersperg/flare/cloudflare"; export class');
    expect(read("packages/flare/src/cli/project.mjs")).toContain(
      'const source = `import {defineApp} from "@auersperg/flare/server";',
    );
  });
  it("help advertises only the cloud dashboard without loading the compiler", () => {
    const output = spawnSync(process.execPath, [cli, "--help"], {
      encoding: "utf8",
    });
    expect(output.status).toBe(0);
    expect(output.stdout).toContain(
      `Flare ${JSON.parse(read("packages/flare/package.json")).version} trusted-team preview`,
    );
    expect(output.stdout).toContain("Cloudflare-only");
    expect(output.stdout).toContain("flare build");
    expect(read("packages/flare/src/cli/main.mjs")).not.toMatch(
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
  it("exports the Flare error identity", async () => {
    expect(new FlareError("TEST", "test").name).toBe("FlareError");
    const client = createClient({ url: "https://example.test" });
    client.dispose();
    await expect(
      client.query({ path: "test", kind: "query" }, {}),
    ).rejects.toBeInstanceOf(FlareError);
  });
  it("the authoritative docs do not offer a second/local dashboard", () => {
    const docs = read("README.md");
    expect(docs).toContain("Cloudflare-hosted only");
    expect(docs).not.toMatch(
      /locally launched copy|optional local UI|reactive build|REACTIVE_KERNEL_URL/,
    );
    expect(JSON.parse(read("package.json")).name).toBe("flare-workspace");
  });
  it("derives public service metadata from manifests without obsolete stages", () => {
    for (const role of ["admin", "runtime"]) {
      const source = read(`packages/core/src/${role}.ts`);
      expect(source).toContain('from "../package.json"');
      expect(source).toContain("version: packageInfo.version");
      expect(source).not.toMatch(/version:\s*["']\d+\.\d+\.\d+["']/);
    }
    expect(read("packages/core/src/admin.ts")).toContain(
      'stage: "trusted-team-preview"',
    );
    expect(read("packages/flare/README.md")).not.toContain(
      "Sessions are memory-only",
    );
    expect(read("packages/flare/README.md")).toContain("await auth.restore()");
  });
  it("keeps local documentation links and heading anchors resolvable", () => {
    const files = [
      "README.md",
      "packages/core/README.md",
      "packages/flare/README.md",
      ...readdirSync(new URL("../docs/", import.meta.url), {
        recursive: true,
        encoding: "utf8",
      })
        .filter((name) => name.endsWith(".md"))
        .map((name) => `docs/${name}`),
    ];
    const withoutCode = (source: string) =>
      source.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, "");
    const anchors = (source: string) => {
      const counts = new Map<string, number>();
      return [...withoutCode(source).matchAll(/^#{1,6}\s+(.+)$/gm)].map(
        ([, heading]) => {
          const slug = heading
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_\- ]/gu, "")
            .replace(/ /g, "-");
          const count = counts.get(slug) ?? 0;
          counts.set(slug, count + 1);
          return count ? `${slug}-${count}` : slug;
        },
      );
    };
    for (const file of files) {
      const base = new URL(`../${file}`, import.meta.url);
      for (const [, href] of withoutCode(read(file)).matchAll(
        /\[[^\]\n]*\]\(([^)\s]+)\)/g,
      )) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
        const target = new URL(href, base);
        const fragment = decodeURIComponent(target.hash.slice(1));
        target.hash = "";
        expect({ file, href, exists: existsSync(target) }).toEqual({
          file,
          href,
          exists: true,
        });
        if (fragment)
          expect(anchors(readFileSync(target, "utf8"))).toContain(fragment);
      }
    }
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
  it("keeps deployment history collapsed within the selected environment", () => {
    const releases = read(
      "packages/core/dashboard/src/components/releases-panel.tsx",
    );
    expect(releases).toContain("Deployment history");
    expect(releases).toContain("<details");
    expect(releases).toContain("scopePath(scope.project, scope.env)");
    expect(releases).not.toMatch(/Manage releases|Close releases|setSource/);
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
      'id="flare-dashboard"',
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
  it("resets changed function contracts and cancels runner preparation on navigation", () => {
    const runner = read(
      "packages/core/dashboard/src/components/functions-view.tsx",
    );
    expect(runner).toContain(
      'key={active[0] + ":" + JSON.stringify(active[1])}',
    );
    expect(runner).toContain("pending.current?.abort()");
    expect(runner).toContain("abort.signal,");
    expect(runner).toContain(
      "if (!alive.current || abort.signal.aborted) return",
    );
    expect(runner).toContain("if (!allowed || busy || pending.current) return");
    expect(read("packages/core/dashboard/src/components/common.tsx")).toContain(
      "? { ...previous, error: undefined, loading: true }",
    );
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
  it("keeps local credential configs out of tracked production source", () => {
    const root = new URL("../", import.meta.url);
    const result = spawnSync("git", ["ls-files", "-z"], {
      cwd: fileURLToPath(root),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    for (const path of result.stdout.split("\0").filter(Boolean)) {
      // Working-tree deletions remain in the index until the maintainer commits.
      if (!existsSync(new URL(path, root)) || path.endsWith(".env.example"))
        continue;
      expect(path).not.toMatch(
        /(^|\/)(?:\.private(?:\/|$)|\.env(?:$|[. ])|\.dev[^/]*\.vars)/,
      );
      expect(path).not.toBe("tests/kernel/wrangler.cloud.json");
    }
  });
  it("keeps formatting in the manifest and no duplicate product/config files at root", () => {
    expect(JSON.parse(read("package.json")).prettier).toEqual({
      plugins: ["prettier-plugin-astro"],
    });
    for (const file of [
      "flare.product.json",
      ".prettierrc.json",
      "admin.wrangler.json",
      "runtime.wrangler.json",
      "admin.wrangler.example.json",
      "runtime.wrangler.example.json",
    ])
      expect(existsSync(new URL(`../${file}`, import.meta.url))).toBe(false);
    expect(
      existsSync(new URL("../scripts/setup-cloud.mjs", import.meta.url)),
    ).toBe(false);
  });
  it("keeps canonical repository metadata and publication guards", () => {
    for (const path of [
      "package.json",
      "packages/core/package.json",
      "packages/flare/package.json",
      "packages/core/dashboard/package.json",
    ]) {
      const pkg = JSON.parse(read(path));
      expect(pkg.repository.url).toBe("https://github.com/auersperg/flare.git");
      expect(pkg.private).toBe(
        path === "packages/flare/package.json" ? undefined : true,
      );
      expect(pkg.license).toBe("MIT");
      expect(pkg.version).toBe(JSON.parse(read("package.json")).version);
    }
  });
  it("keeps the sole managed generator and no direct-deploy configuration copies", () => {
    const ignore = read(".gitignore");
    for (const path of [
      "/tests/kernel/wrangler.cloud.json",
      ".private/",
      ".dev.vars*",
      ".dev*.vars*",
      ".env*",
    ])
      expect(ignore.split("\n")).toContain(path);
    for (const role of ["admin", "runtime"])
      expect(
        existsSync(
          new URL(
            `../packages/core/${role}.wrangler.example.json`,
            import.meta.url,
          ),
        ),
      ).toBe(false);
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
  it("publishes only by an approved main-branch OIDC workflow", () => {
    const workflow = read(".github/workflows/publish.yml");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("environment: npm");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("bun run verify");
    expect(workflow).toContain("bun run test:kernel");
    expect(workflow).toContain("--provenance");
    expect(workflow).not.toMatch(
      /secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|pull_request_target|wrangler deploy/,
    );
    expect(read("LICENSE")).toContain("MIT License");
  });
  it("has no demo workspaces or build-time demo dependencies", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.workspaces).toEqual([
      "packages/flare",
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
    expect(clean).toContain('"packages/flare/dist"');
    expect(clean).not.toMatch(/rm\([^\n]*\.private|rm\([^\n]*node_modules/);
    expect(clean).not.toMatch(/fetch\(|child_process/);
  });
});
