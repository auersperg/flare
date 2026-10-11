#!/usr/bin/env bun
if (
  typeof Bun === "undefined" ||
  !Bun.semver.satisfies(Bun.version, ">=1.4.3")
) {
  console.error("Flare CLI requires Bun 1.4.3 or newer.");
  process.exit(1);
}
const [command, ...args] = process.argv.slice(2);
if (!command || ["--help", "help"].includes(command))
  console.log(
    'Flare 0.3 private minimum\n\nflare dev                  Browser login, setup and cloud dev watch\nflare deploy               Confirmed production build and deploy\n\nAdvanced commands:\nflare releases --env dev|prod\nflare promote --hash <dev release hash> [--cmd "bun run build"]\nflare rollback --hash <retained release hash> --env dev|prod\nflare build --entry <app.ts> --outdir <new directory>\nflare link --platform <management URL> --project <ID>\nflare deploy --env dev|prod --release <directory> [--confirm <project ID>]\nflare dev --entry <app.ts>\nflare backup create|list|restore|delete|status --env dev|prod\n  restore --from dev|prod --id <backup ID> (empty target only)\n\nDashboard is Cloudflare-only. Local tooling does not run a dashboard or backend. CLI authentication uses FLARE_DEPLOY_TOKEN from the online dashboard. Run flare dev with no flags for browser login, project selection and automatic schema/API generation. Run flare deploy with no flags for a confirmed production release. Platform installation is separate.',
  );
else if (
  [
    "build",
    "link",
    "deploy",
    "dev",
    "backup",
    "promote",
    "rollback",
    "releases",
  ].includes(command)
) {
  try {
    const options = {};
    if (command === "backup") options.operation = args.shift() ?? "list";
    const permitted = {
      build: ["entry", "outdir"],
      link: ["platform", "project"],
      deploy: ["env", "release", "confirm", "cmd"],
      promote: ["env", "hash", "confirm", "cmd"],
      rollback: ["env", "hash", "confirm", "cmd"],
      releases: ["env"],
      dev: ["entry", "env"],
      backup: ["env", "id", "from", "confirm", "cursor"],
    }[command];
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]?.replace(/^--/, "");
      if (
        !args[i]?.startsWith("--") ||
        !permitted.includes(key) ||
        !args[i + 1] ||
        args[i + 1].startsWith("--") ||
        key in options
      )
        throw Error("Expected supported unique named options");
      options[key] = args[i + 1];
    }
    if (command === "build") {
      if (!options.entry || !options.outdir)
        throw Error("Required: --entry, --outdir");
      const { buildApplication } = await import("./build.mjs");
      const x = await buildApplication(options);
      console.log(`Built immutable release ${x.hash}\n${x.outdir}`);
    } else {
      const cloud = await import("./cloud.mjs");
      const x = await cloud[command](options);
      if (x) console.log(JSON.stringify(x, null, 2));
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Command failed");
    process.exitCode = 1;
  }
} else {
  console.error(`Unsupported command: ${command}; no deployment has occurred.`);
  process.exitCode = 1;
}
