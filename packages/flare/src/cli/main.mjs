#!/usr/bin/env bun
import packageInfo from "../../package.json" with { type: "json" };
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
    `Flare ${packageInfo.version} trusted-team preview\n\nflare dev                  Browser login, setup and cloud dev watch\nflare deploy               Confirmed production build and deploy\n\nPlatform lifecycle (Cloudflare account authorization):\nflare platform install\nflare platform adopt --owner <existing owner email>\nflare platform status\nflare platform update --dry-run\nflare platform update\n\nAdvanced commands:\nflare releases --env dev|prod\nflare promote --hash <dev release hash> [--cmd "bun run build"]\nflare rollback --hash <retained release hash> --env dev|prod\nflare build --entry <app.ts> --outdir <new directory>\nflare link --platform <management URL> --project <ID>\nflare deploy --env dev|prod --release <directory> [--confirm <project ID>]\nflare dev --entry <app.ts>\nflare backup create|list|restore|delete|status --env dev|prod\n  restore --from dev|prod --id <backup ID> (empty target only)\n\nDashboard is Cloudflare-only. Local tooling does not run a dashboard or backend. Run flare dev for Access-protected browser approval and project-scoped credentials stored outside the application; CI can use FLARE_DEPLOY_TOKEN. Backend dev runs in Cloudflare; start the frontend separately. Production changes require project confirmation. Platform installation is separate.`,
  );
else if (command === "platform") {
  try {
    const operation = args.shift();
    if (["help", "--help"].includes(operation)) {
      console.log(
        "flare platform install|status|update|adopt [--account <ID>] [--name <name>]\ninstall: [--owner <email>] [--dashboard-host <host> --runtime-host <host>] [--subdomain <workers.dev prefix>]\nadopt: --owner <email> (existing standard flare-admin/flare-runtime/flare-catalog; default installation only)\ninstall/update: [--config <operator JSON>]\nupdate: [--accept-access <reviewed snapshot SHA256>]\ninstall/update/adopt: [--dry-run] [--confirm <account ID>] [--resume]\nUses the platform payload bundled with this CLI release. Never updates applications or runs a local dashboard. Requires separate Cloudflare account permissions; FLARE_DEPLOY_TOKEN is not an account token.",
      );
    } else {
      if (!["install", "status", "update", "adopt"].includes(operation))
        throw Error(
          "Supported: flare platform install|status|update|adopt; no deployment has occurred.",
        );
      const options = { operation };
      const allowed =
        operation === "adopt"
          ? ["account", "name", "owner", "confirm", "dry-run", "resume"]
          : operation === "install"
            ? [
                "account",
                "name",
                "owner",
                "dashboard-host",
                "runtime-host",
                "subdomain",
                "confirm",
                "dry-run",
                "resume",
                "config",
              ]
            : operation === "update"
              ? [
                  "account",
                  "name",
                  "confirm",
                  "dry-run",
                  "resume",
                  "config",
                  "accept-access",
                ]
              : ["account", "name"];
      for (let i = 0; i < args.length; i++) {
        const key = args[i]?.slice(2);
        if (
          !args[i]?.startsWith("--") ||
          !allowed.includes(key) ||
          key in options
        )
          throw Error(
            "Expected supported unique platform options; no deployment has occurred.",
          );
        if (["dry-run", "resume"].includes(key)) options[key] = true;
        else {
          if (!args[i + 1] || args[i + 1].startsWith("--"))
            throw Error(
              "Platform option requires a value; no deployment has occurred.",
            );
          options[key] = args[++i];
        }
      }
      const { platform } = await import("./platform.mjs");
      console.log(JSON.stringify(await platform(options), null, 2));
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Platform command failed",
    );
    process.exitCode = 1;
  }
} else if (
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
