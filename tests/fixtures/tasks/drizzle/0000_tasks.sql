CREATE TABLE tasks (id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX tasks_created ON tasks(createdAt,id);
