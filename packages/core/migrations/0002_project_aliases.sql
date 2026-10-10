-- Permanent names: never reuse an alias for another project, even after deletion.
CREATE TABLE project_aliases (
  projectId TEXT PRIMARY KEY REFERENCES projects(id),
  alias TEXT NOT NULL UNIQUE,
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1))
);
