-- Keep short URLs permanently reserved without keeping deleted projects alive.
CREATE TABLE project_aliases_next (
  projectId TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1))
);
INSERT INTO project_aliases_next SELECT * FROM project_aliases;
DROP TABLE project_aliases;
ALTER TABLE project_aliases_next RENAME TO project_aliases;
-- A durable control-plane barrier: failed cleanup can be retried, not reopened.
CREATE TABLE project_deletions (projectId TEXT PRIMARY KEY,startedAt INTEGER NOT NULL);
