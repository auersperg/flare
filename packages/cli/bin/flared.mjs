#!/usr/bin/env node
const [command, ...args] = process.argv.slice(2);
if (!command || ["--help", "help"].includes(command))
  console.log(
    "Flared 0.2 private minimum\n\nflared build --entry <app.ts> --migrations <directory> --outdir <new directory>\nflared link --platform <management URL> --project <ID>\nflared deploy --env dev|prod --release <directory> [--confirm <project ID>]\nflared dev --entry <app.ts> --migrations <directory>\n\nDashboard is Cloudflare-only. Local tooling does not run a dashboard or backend. CLI authentication uses FLARED_DEPLOY_TOKEN from the online dashboard. General platform installation and db generate are not yet implemented.",
  );
else if (["build", "link", "deploy", "dev"].includes(command)) {
  try {
    const options = {};
    const permitted = {
      build: ["entry", "migrations", "outdir"],
      link: ["platform", "project"],
      deploy: ["env", "release", "confirm"],
      dev: ["entry", "migrations", "env"],
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
      if (!options.entry || !options.migrations || !options.outdir)
        throw Error("Required: --entry, --migrations, --outdir");
      const { buildApplication } = await import("../lib/build.mjs");
      const x = await buildApplication(options);
      console.log(`Built immutable release ${x.hash}\n${x.outdir}`);
    } else {
      const cloud = await import("../lib/cloud.mjs");
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
