import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { hasPendingMigrations, migrationManifest, runMigrations } from "./Migrations.ts";
import { ensureMultiRepoSchema, isMultiRepoSchemaCurrent } from "./MultiRepoSchema.ts";

const latestNumberedId = Math.max(...migrationManifest.map(([id]) => id));

const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly sql: string;
  }>`
    SELECT type, name, sql FROM sqlite_master
    WHERE name IN ('projection_projects', 'task_folders', 'idx_task_folders_real_root')
    ORDER BY name
  `;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  return { objects, columns: columns.map((column) => column.name) };
});

describe("ensureMultiRepoSchema", () => {
  it.effect("adds the schema after the numbered migrations and is a no-op the second time", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: latestNumberedId });
      assert.isFalse(yield* isMultiRepoSchemaCurrent);
      assert.isTrue(yield* hasPendingMigrations());

      yield* runMigrations();
      assert.isTrue(yield* isMultiRepoSchemaCurrent);
      assert.isFalse(yield* hasPendingMigrations());
      const first = yield* schema;
      assert.include(first.columns, "tracked_folders_json");

      yield* runMigrations();
      yield* ensureMultiRepoSchema;
      assert.deepStrictEqual(yield* schema, first);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps a schema that an upstream migration already created, with its rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: latestNumberedId });
      // The DDL of the multi-repo stack's 086 and 087 migrations.
      yield* sql`
        ALTER TABLE projection_projects
        ADD COLUMN tracked_folders_json TEXT NOT NULL DEFAULT '[]'
      `;
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
      yield* sql`
        INSERT INTO task_folders VALUES ('/task', '/task', 'project', '/p', '/p', '/task', 0, '[]', 'now')
      `;
      const before = yield* schema;

      yield* runMigrations();
      yield* runMigrations();

      assert.deepStrictEqual(yield* schema, before);
      const rows = yield* sql<{ readonly root: string }>`SELECT root FROM task_folders`;
      assert.deepStrictEqual(
        rows.map((row) => row.root),
        ["/task"],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
