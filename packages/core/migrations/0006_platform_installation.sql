CREATE TABLE IF NOT EXISTS flare_installation (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  installation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(json_valid(state)),
  revision INTEGER NOT NULL DEFAULT 0,
  lock_owner TEXT,
  lock_expires INTEGER NOT NULL DEFAULT 0
);
