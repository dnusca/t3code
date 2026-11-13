import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Multi-repo project schema, kept out of the numbered migrations: the migrator skips every id up
// to the highest recorded one, so a fork-only id would hide the next upstream migration. Each step
// checks first, so this is a no-op once the schema exists, including one an upstream migration made.
// The DDL matches the multi-repo stack's 086_ProjectionProjectsTrackedFolders and 087_TaskFolders.

const hasTrackedFoldersColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  return columns.some((column) => column.name === "tracked_folders_json");
});

const hasSchemaObject = Effect.fn("MultiRepoSchema.hasSchemaObject")(function* (
  type: "table" | "index",
  name: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM sqlite_master WHERE type = ${type} AND name = ${name}`;
  return rows.length > 0;
});

export const isMultiRepoSchemaCurrent = Effect.gen(function* () {
  return (
    (yield* hasTrackedFoldersColumn) &&
    (yield* hasSchemaObject("table", "task_folders")) &&
    (yield* hasSchemaObject("index", "idx_task_folders_real_root"))
  );
});

export const ensureMultiRepoSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* hasTrackedFoldersColumn)) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN tracked_folders_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
  // Keyed by folder: subagents, forks and reused worktrees share one path across threads.
  yield* sql`
    CREATE TABLE IF NOT EXISTS task_folders (
      root TEXT PRIMARY KEY,
      real_root TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      anchor TEXT NOT NULL,
      project_path TEXT NOT NULL,
      project_is_worktree INTEGER NOT NULL,
      repositories_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_task_folders_real_root ON task_folders (real_root)`;
}).pipe(Effect.withSpan("ensureMultiRepoSchema"));
