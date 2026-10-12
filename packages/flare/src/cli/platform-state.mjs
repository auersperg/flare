import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { sha256 } from "./platform-release.mjs";

export const leaseMilliseconds = 15 * 60 * 1000;
const identifier = /^[a-z][a-z0-9-]{0,19}$/;
const resourceName = /^[a-z][a-z0-9-]{0,62}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const validName = (name) => identifier.test(name);
export function hostname(value) {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)
  )
    throw Error(
      "Enter a plain lowercase public hostname, without protocol, path or port",
    );
  return value;
}
export function validateState(state, account, name) {
  if (
    !state ||
    state.format !== 1 ||
    state.account !== account ||
    state.name !== name ||
    !uuid.test(state.id ?? "") ||
    !validName(name) ||
    typeof state.owner !== "string" ||
    !/^\S+@\S+\.\S+$/.test(state.owner) ||
    state.owner.length > 254
  )
    throw Error("Unsupported installation state or account/name mismatch");
  const prefix = `flare-${name}-${state.id.replaceAll("-", "").slice(0, 12)}`;
  const operator = state.origin === "operator";
  if (state.origin !== undefined && !operator)
    throw Error("Unsupported installation origin");
  if (
    operator &&
    (name !== "default" ||
      !state.addresses?.custom ||
      !/^\d{1,10}$/.test(state.rateLimitNamespace ?? ""))
  )
    throw Error("Unsupported operator installation identity");
  const legacy = {
    catalog: "flare-catalog",
    bundles: "flare-builds",
    files: "flare-files",
    jobs: "flare-jobs",
    dlq: "flare-jobs-dlq",
  };
  for (const key of ["catalog", "bundles", "files", "jobs", "dlq"])
    if (
      !resourceName.test(state.resources?.[key]?.name ?? "") ||
      state.resources[key].name !==
        (operator
          ? legacy[key]
          : key === "catalog"
            ? `flare-${name}-catalog`
            : `${prefix}-${key}`)
    )
      throw Error("Invalid installation resource identity");
  if (
    state.resources.catalog.id !== null &&
    !uuid.test(state.resources.catalog.id)
  )
    throw Error("Invalid catalogue identity");
  for (const key of ["admin", "runtime"])
    if (
      !resourceName.test(state.workers?.[key]?.name ?? "") ||
      state.workers[key].name !==
        (operator ? `flare-${key}` : `${prefix}-${key}`)
    )
      throw Error("Invalid Worker identity");
  if (
    typeof state.addresses?.custom !== "boolean" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(state.addresses.subdomain ?? "")
  )
    throw Error("Invalid installation address configuration");
  for (const key of ["adminHost", "runtimeHost"])
    hostname(state.addresses?.[key]);
  if (
    !state.addresses.custom &&
    (state.addresses.adminHost !==
      `${prefix}-admin.${state.addresses.subdomain}.workers.dev` ||
      state.addresses.runtimeHost !==
        `${prefix}-runtime.${state.addresses.subdomain}.workers.dev`)
  )
    throw Error("workers.dev address does not match Worker identity");
  if (state.addresses.adminHost === state.addresses.runtimeHost)
    throw Error("Admin and Runtime hostnames must differ");
  if (
    state.access &&
    (!/^[a-f0-9-]{36}$/.test(state.access.id ?? "") ||
      !/^[a-f0-9]{64}$/.test(state.access.aud ?? "") ||
      !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(
        state.access.issuer ?? "",
      ))
  )
    throw Error("Invalid installation Access identity");
  if (
    state.operation &&
    (!uuid.test(state.operation.id ?? "") ||
      !["install", "update", "adopt"].includes(state.operation.kind) ||
      !/^[a-f0-9]{64}$/.test(state.operation.targetDigest ?? "") ||
      !Array.isArray(state.operation.completed) ||
      state.operation.completed.some(
        (step) =>
          ![
            "resources",
            "access",
            "migrations",
            "owner",
            "bootstrap",
            "signing-key",
            "runtime",
            "admin",
            "verify",
          ].includes(step),
      ))
  )
    throw Error("Invalid platform operation checkpoint");
  if (
    state.installed &&
    (!/^[a-f0-9]{64}$/.test(state.installed.digest ?? "") ||
      !Array.isArray(state.installed.migrations))
  )
    throw Error("Invalid installed release checkpoint");
  return state;
}

export function newInstallation({
  account,
  name,
  owner,
  subdomain,
  adminHost,
  runtimeHost,
}) {
  if (
    !/^[a-f0-9]{32}$/.test(account) ||
    !validName(name) ||
    typeof owner !== "string" ||
    owner.length > 254 ||
    !/^\S+@\S+\.\S+$/.test(owner)
  )
    throw Error("Invalid account, installation name or owner email");
  if (!!adminHost !== !!runtimeHost)
    throw Error("Provide both --dashboard-host and --runtime-host, or neither");
  const id = randomUUID(),
    prefix = `flare-${name}-${id.replaceAll("-", "").slice(0, 12)}`;
  subdomain ??= "flare-" + id.replaceAll("-", "").slice(0, 12);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain))
    throw Error("Invalid workers.dev subdomain");
  const resources = Object.fromEntries(
    ["catalog", "bundles", "files", "jobs", "dlq"].map((key) => [
      key,
      { name: `${prefix}-${key}`, id: null },
    ]),
  );
  resources.catalog.name = `flare-${name}-catalog`;
  return validateState(
    {
      format: 1,
      id,
      account,
      name,
      owner: owner.toLowerCase(),
      resources,
      workers: {
        admin: { name: `${prefix}-admin` },
        runtime: { name: `${prefix}-runtime` },
      },
      addresses: {
        custom: !!adminHost,
        subdomain,
        adminHost: adminHost
          ? hostname(adminHost)
          : `${prefix}-admin.${subdomain}.workers.dev`,
        runtimeHost: runtimeHost
          ? hostname(runtimeHost)
          : `${prefix}-runtime.${subdomain}.workers.dev`,
      },
      access: null,
      installed: null,
      operation: null,
      snapshots: {},
      versions: {},
      createdAt: Date.now(),
    },
    account,
    name,
  );
}

export class InstallationStore {
  constructor(
    cf,
    name,
    {
      directory = join(
        process.env.FLARE_CONFIG_HOME ?? join(homedir(), ".config", "flare"),
        "platform",
      ),
      now = Date.now,
    } = {},
  ) {
    this.cf = cf;
    this.name = name;
    this.directory = directory;
    this.now = now;
    this.file = join(directory, `${cf.account}-${name}.json`);
    this.lockOwner = randomUUID();
    this.revision = 0;
  }
  async cache(state) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = this.file + "." + this.lockOwner + ".tmp";
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temporary, this.file);
    await chmod(this.file, 0o600);
  }
  async local() {
    const source = await readFile(this.file, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    return source
      ? validateState(JSON.parse(source), this.cf.account, this.name)
      : null;
  }
  async row(database) {
    const table = await this.cf.sql(
      database,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='flare_installation'",
    );
    if (!table.results.length) return null;
    const result = await this.cf.sql(
      database,
      "SELECT * FROM flare_installation WHERE singleton=1",
    );
    const row = result.results[0];
    if (!row) return null;
    const state = validateState(
      JSON.parse(row.state),
      this.cf.account,
      this.name,
    );
    if (
      state.id !== row.installation_id ||
      state.resources.catalog.id !== database
    )
      throw Error("Catalogue identity does not match installation state");
    return { ...row, state };
  }
  async discover() {
    const local = await this.local();
    if (local?.resources.catalog.id) {
      const row = await this.row(local.resources.catalog.id);
      if (row) {
        this.revision = row.revision;
        return { state: row.state, row };
      }
      if (local.installed)
        throw Error(
          "Managed installation state is missing; refusing to recreate resources",
        );
      return { state: local, row: null };
    }
    const candidates = (await this.cf.list("d1/database")).filter(
      (db) =>
        db.name === `flare-${this.name}-catalog` ||
        (this.name === "default" && db.name === "flare-catalog"),
    );
    const found = [];
    for (const candidate of candidates) {
      const row = await this.row(candidate.uuid);
      if (row) found.push(row);
      else if (candidate.name === "flare-catalog")
        throw Error(
          "Legacy operator installation found. Use explicit platform adopt; do not reinstall over existing data.",
        );
      else if (candidate.name !== local?.resources.catalog.name)
        throw Error(
          "Unmanaged catalogue found. Refusing implicit adoption; use a distinct installation name or an explicit migration.",
        );
    }
    if (found.length > 1)
      throw Error(
        "Multiple installations have this name; refusing ambiguous resource selection",
      );
    if (found.length) {
      this.revision = found[0].revision;
      return { state: found[0].state, row: found[0] };
    }
    return { state: local, row: null };
  }
  async initialize(state, ddl) {
    const db = state.resources.catalog.id;
    await this.cf.sql(db, ddl);
    await this.cf.sql(
      db,
      "INSERT OR IGNORE INTO flare_installation(singleton,installation_id,state,revision) VALUES(1,?,?,0)",
      [state.id, JSON.stringify(state)],
    );
    const row = await this.row(db);
    if (!row || row.state.id !== state.id)
      throw Error("Installation identity is already claimed");
    this.revision = row.revision;
  }
  async acquire(state, resume = false) {
    const now = this.now();
    const row = await this.row(state.resources.catalog.id);
    if (!row || row.state.id !== state.id)
      throw Error("Installation ownership could not be established");
    if (row.revision !== this.revision)
      throw Error(
        "Installation state changed while preparing the operation; rerun status and the requested command",
      );
    if (row.lock_owner && (row.lock_expires > now || !resume))
      throw Error(
        "Installation operation is locked. After an interrupted process, wait 15 minutes and explicitly use --resume.",
      );
    const result = await this.cf.sql(
      state.resources.catalog.id,
      "UPDATE flare_installation SET lock_owner=?,lock_expires=? WHERE singleton=1 AND revision=? AND (lock_owner IS NULL OR lock_expires<=?)",
      [this.lockOwner, now + leaseMilliseconds, row.revision, now],
    );
    if (result.meta?.changes !== 1)
      throw Error("Concurrent platform operation; no deployment was started");
    this.revision = row.revision;
  }
  async save(state) {
    const now = this.now();
    const result = await this.cf.sql(
      state.resources.catalog.id,
      "UPDATE flare_installation SET state=?,revision=revision+1,lock_expires=? WHERE singleton=1 AND installation_id=? AND revision=? AND lock_owner=? AND lock_expires>?",
      [
        JSON.stringify(state),
        now + leaseMilliseconds,
        state.id,
        this.revision,
        this.lockOwner,
        now,
      ],
    );
    if (result.meta?.changes !== 1)
      throw Error(
        "Platform operation lost its lease; stop and inspect platform status",
      );
    this.revision++;
    await this.cache(state);
  }
  async release(state) {
    await this.cf.sql(
      state.resources.catalog.id,
      "UPDATE flare_installation SET lock_owner=NULL,lock_expires=0 WHERE singleton=1 AND lock_owner=?",
      [this.lockOwner],
    );
  }
}

export function settingsDigest(settings) {
  // No remote variable/secret values are written to local/cloud state.
  const { annotations: _annotations, ...stable } = settings;
  stable.bindings = [...(settings.bindings ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return configurationDigest(stable);
}

export function configurationDigest(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonical(item[key])]),
      );
    return item;
  };
  return sha256(JSON.stringify(canonical(value)));
}
