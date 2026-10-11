CREATE TABLE cli_logins (
  id TEXT PRIMARY KEY,
  secretHash TEXT NOT NULL,
  publicKey TEXT NOT NULL,
  code TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  payload TEXT
);
CREATE INDEX cli_logins_expiry ON cli_logins(expiresAt);
