/**
 * SQLite database setup, migrations, and schema creation.
 * Uses better-sqlite3 for synchronous access — ideal for MCP stdio transport.
 *
 * Schema versioning: PRAGMA user_version tracks applied migrations.
 * Each migration function is wrapped in a transaction and applied in order.
 */

import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stemText } from "./stemmer.js";

const DB_DIR = join(homedir(), ".mnemon-mcp");
const DB_PATH = process.env["MNEMON_DB_PATH"] ?? join(DB_DIR, "memory.db");

/** Target schema version. Increment when adding new migrations. */
const SCHEMA_VERSION = 7;

/**
 * Open (or create) the SQLite database with WAL mode and all required tables.
 * Idempotent — safe to call on every server startup.
 */
export function openDatabase(dbPath: string = DB_PATH): Database.Database {
  if (dbPath !== ":memory:") {
    const dir = join(dbPath, "..");
    // mode is ignored for pre-existing dirs — chmod repairs installs created
    // before this hardening (SECURITY.md promises user-only permissions)
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch (err) {
      console.error(`[mnemon-mcp] Could not restrict db directory permissions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const db = new Database(dbPath);

  if (dbPath !== ":memory:") {
    // Chmod before the WAL pragma below creates -wal/-shm — they inherit the
    // database file's permissions; existing sidecars are repaired explicitly
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(dbPath + suffix, 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`[mnemon-mcp] Could not restrict permissions on ${dbPath}${suffix}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  // WAL mode: better concurrent read performance, atomic writes
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  runMigrations(db);

  return db;
}

/**
 * Run all pending schema migrations using PRAGMA user_version as version tracker.
 * Each migration is wrapped in a transaction and applied in order.
 */
function runMigrations(db: Database.Database): void {
  let currentVersion = db.pragma("user_version", { simple: true }) as number;

  if (currentVersion < 1) {
    applyMigration1(db);
    db.pragma("user_version = 1");
    currentVersion = 1;
  }

  if (currentVersion < 2) {
    applyMigration2(db);
    db.pragma("user_version = 2");
    currentVersion = 2;
  }

  if (currentVersion < 3) {
    applyMigration3(db);
    backfillStemmedContent(db);
    db.pragma("user_version = 3");
    currentVersion = 3;
  }

  if (currentVersion < 4) {
    applyMigration4(db);
    db.pragma("user_version = 4");
    currentVersion = 4;
  }

  if (currentVersion < 5) {
    applyMigration5(db);
    db.pragma("user_version = 5");
    currentVersion = 5;
  }

  if (currentVersion < 6) {
    applyMigration6(db);
    db.pragma("user_version = 6");
    currentVersion = 6;
  }

  if (currentVersion < 7) {
    applyMigration7(db);
    db.pragma("user_version = 7");
    currentVersion = 7;
  }
}

/**
 * Migration v1: initial schema — sessions, memories, import_log, event_log,
 * FTS5 virtual table, partial indexes, and FTS5 sync triggers.
 */
function applyMigration1(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      -- =========================================================
      -- sessions: track agent sessions for episodic context
      -- =========================================================
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        client     TEXT NOT NULL,
        project    TEXT,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        ended_at   TEXT,
        summary    TEXT,
        meta       TEXT NOT NULL DEFAULT '{}'
      );

      -- =========================================================
      -- memories: unified 4-layer memory table
      -- =========================================================
      CREATE TABLE IF NOT EXISTS memories (
        id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        layer         TEXT NOT NULL CHECK (layer IN ('episodic', 'semantic', 'procedural', 'resource')),
        content       TEXT NOT NULL,
        title         TEXT,
        source        TEXT NOT NULL,
        source_file   TEXT,
        session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        event_at      TEXT,
        expires_at    TEXT,
        confidence    REAL NOT NULL DEFAULT 0.8 CHECK (confidence BETWEEN 0.0 AND 1.0),
        importance    REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0.0 AND 1.0),
        access_count  INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT,
        superseded_by TEXT REFERENCES memories(id) ON DELETE SET NULL,
        supersedes    TEXT REFERENCES memories(id) ON DELETE SET NULL,
        entity_type   TEXT CHECK (entity_type IN ('user','project','person','concept','file','rule','tool') OR entity_type IS NULL),
        entity_name   TEXT,
        scope         TEXT NOT NULL DEFAULT 'global',
        embedding     BLOB,
        meta          TEXT NOT NULL DEFAULT '{}'
      );

      -- =========================================================
      -- import_log: track file import history for deduplication
      -- =========================================================
      CREATE TABLE IF NOT EXISTS import_log (
        id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        source_path       TEXT NOT NULL,
        source_type       TEXT NOT NULL CHECK (source_type IN ('claude-md','kb-markdown','json','chatgpt-export')),
        imported_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        memories_created  INTEGER NOT NULL DEFAULT 0,
        memories_updated  INTEGER NOT NULL DEFAULT 0,
        file_hash         TEXT,
        status            TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','partial','failed')),
        errors            TEXT NOT NULL DEFAULT '[]'
      );

      -- =========================================================
      -- event_log: append-only audit trail for all memory mutations
      -- =========================================================
      CREATE TABLE IF NOT EXISTS event_log (
        id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        memory_id   TEXT NOT NULL,
        event_type  TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'superseded')),
        actor       TEXT NOT NULL DEFAULT 'api',
        old_content TEXT,
        new_content TEXT,
        diff_meta   TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_event_log_memory
        ON event_log(memory_id);

      CREATE INDEX IF NOT EXISTS idx_event_log_occurred
        ON event_log(occurred_at DESC);

      -- =========================================================
      -- FTS5: full-text search across title, content, entity_name
      -- Standalone (not content=) for simpler trigger-based sync
      -- unicode61 tokenizer: Cyrillic + Latin support (no morphological stemming)
      -- =========================================================
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        id UNINDEXED,
        title,
        content,
        entity_name,
        tokenize='unicode61 remove_diacritics 2'
      );

      -- =========================================================
      -- Partial indexes — superseded entries excluded from search
      -- =========================================================
      CREATE INDEX IF NOT EXISTS idx_memories_layer
        ON memories(layer)
        WHERE superseded_by IS NULL;

      CREATE INDEX IF NOT EXISTS idx_memories_entity
        ON memories(entity_type, entity_name)
        WHERE superseded_by IS NULL;

      CREATE INDEX IF NOT EXISTS idx_memories_event_at
        ON memories(event_at)
        WHERE layer = 'episodic' AND event_at IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_memories_expires
        ON memories(expires_at)
        WHERE expires_at IS NOT NULL AND superseded_by IS NULL;

      CREATE INDEX IF NOT EXISTS idx_memories_scope
        ON memories(scope, layer)
        WHERE superseded_by IS NULL;

      CREATE INDEX IF NOT EXISTS idx_memories_rank
        ON memories(importance DESC, confidence DESC)
        WHERE superseded_by IS NULL;

      CREATE INDEX IF NOT EXISTS idx_memories_source_file
        ON memories(source_file)
        WHERE source_file IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_memories_session
        ON memories(session_id)
        WHERE session_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_import_log_hash
        ON import_log(source_path, file_hash)
        WHERE file_hash IS NOT NULL;

      -- =========================================================
      -- FTS5 sync triggers
      -- =========================================================
      CREATE TRIGGER IF NOT EXISTS memories_fts_insert
      AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(id, title, content, entity_name)
        VALUES (NEW.id, NEW.title, NEW.content, NEW.entity_name);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_update
      AFTER UPDATE ON memories BEGIN
        UPDATE memories_fts
        SET title       = NEW.title,
            content     = NEW.content,
            entity_name = NEW.entity_name
        WHERE id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_delete
      AFTER DELETE ON memories BEGIN
        DELETE FROM memories_fts WHERE id = OLD.id;
      END;

      -- =========================================================
      -- Auto-update updated_at on memories modification
      -- =========================================================
      CREATE TRIGGER IF NOT EXISTS memories_updated_at
      AFTER UPDATE ON memories
      WHEN OLD.updated_at = NEW.updated_at BEGIN
        UPDATE memories SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = NEW.id;
      END;
    `);
  })();
}

/**
 * Migration v2:
 * - FTS5 update trigger: only re-index when content/title/entity_name actually changed
 *   (prevents unnecessary FTS writes on access_count/last_accessed updates)
 * - event_log: add 'deleted' event type for memory_delete support
 */
function applyMigration2(db: Database.Database): void {
  db.transaction(() => {
    // Recreate FTS update trigger with WHEN clause to skip no-op content changes
    db.prepare(`DROP TRIGGER IF EXISTS memories_fts_update`).run();
    db.prepare(`
      CREATE TRIGGER memories_fts_update
      AFTER UPDATE ON memories
      WHEN OLD.content != NEW.content
        OR OLD.title IS NOT NEW.title
        OR OLD.entity_name IS NOT NEW.entity_name
      BEGIN
        UPDATE memories_fts
        SET title       = NEW.title,
            content     = NEW.content,
            entity_name = NEW.entity_name
        WHERE id = NEW.id;
      END
    `).run();

    // Recreate event_log with 'deleted' event type support
    db.prepare(`
      CREATE TABLE IF NOT EXISTS event_log_v2 (
        id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        memory_id   TEXT NOT NULL,
        event_type  TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'superseded', 'deleted')),
        actor       TEXT NOT NULL DEFAULT 'api',
        old_content TEXT,
        new_content TEXT,
        diff_meta   TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `).run();
    db.prepare(`INSERT OR IGNORE INTO event_log_v2 SELECT * FROM event_log`).run();
    db.prepare(`DROP TABLE event_log`).run();
    db.prepare(`ALTER TABLE event_log_v2 RENAME TO event_log`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_event_log_memory ON event_log(memory_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_event_log_occurred ON event_log(occurred_at DESC)`).run();
  })();
}

/**
 * Safely add a column to a table — ignores "duplicate column name" errors
 * so migrations are idempotent if they partially ran before PRAGMA update.
 */
function safeAddColumn(db: Database.Database, table: string, column: string, type: string): void {
  try {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!msg.includes("duplicate column name")) throw err;
  }
}

/**
 * Safely drop a column from a table — ignores "no such column" errors
 * so migrations are idempotent if they partially ran before PRAGMA update.
 */
function safeDropColumn(db: Database.Database, table: string, column: string): void {
  try {
    db.prepare(`ALTER TABLE ${table} DROP COLUMN ${column}`).run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!msg.includes("no such column")) throw err;
  }
}

/**
 * Migration v3: Index-time stemming.
 * - Add stemmed_content and stemmed_title columns to memories table
 * - Recreate all FTS5 triggers to use stemmed columns (with COALESCE fallback)
 * - Backfill runs separately after this migration (requires JS stemmer)
 */
function applyMigration3(db: Database.Database): void {
  db.transaction(() => {
    // Add stemmed columns (idempotent — safe if migration partially ran before)
    safeAddColumn(db, "memories", "stemmed_content", "TEXT");
    safeAddColumn(db, "memories", "stemmed_title", "TEXT");

    // Recreate FTS5 insert trigger — use stemmed columns with fallback
    db.prepare(`DROP TRIGGER IF EXISTS memories_fts_insert`).run();
    db.prepare(`
      CREATE TRIGGER memories_fts_insert
      AFTER INSERT ON memories
      BEGIN
        INSERT INTO memories_fts(id, title, content, entity_name)
        VALUES (
          NEW.id,
          COALESCE(NEW.stemmed_title, NEW.title),
          COALESCE(NEW.stemmed_content, NEW.content),
          NEW.entity_name
        );
      END
    `).run();

    // Recreate FTS5 update trigger — use stemmed columns, keep WHEN clause
    db.prepare(`DROP TRIGGER IF EXISTS memories_fts_update`).run();
    db.prepare(`
      CREATE TRIGGER memories_fts_update
      AFTER UPDATE ON memories
      WHEN OLD.content != NEW.content
        OR OLD.title IS NOT NEW.title
        OR OLD.entity_name IS NOT NEW.entity_name
        OR OLD.stemmed_content IS NOT NEW.stemmed_content
        OR OLD.stemmed_title IS NOT NEW.stemmed_title
      BEGIN
        UPDATE memories_fts
        SET title       = COALESCE(NEW.stemmed_title, NEW.title),
            content     = COALESCE(NEW.stemmed_content, NEW.content),
            entity_name = NEW.entity_name
        WHERE id = NEW.id;
      END
    `).run();

    // Delete trigger unchanged — no stemming needed for DELETE
  })();
}

/**
 * Migration v4: Temporal fact windows + entity aliases.
 * - Add valid_from and valid_until columns for time-scoped facts
 * - Create entity_aliases table for alias resolution in search
 */
function applyMigration4(db: Database.Database): void {
  db.transaction(() => {
    safeAddColumn(db, "memories", "valid_from", "TEXT");
    safeAddColumn(db, "memories", "valid_until", "TEXT");

    db.prepare(`
      CREATE TABLE IF NOT EXISTS entity_aliases (
        canonical TEXT NOT NULL,
        alias TEXT NOT NULL UNIQUE,
        PRIMARY KEY (canonical, alias),
        CHECK (alias != canonical)
      )
    `).run();
  })();
}

/**
 * Migration v5: Search query logging.
 * - Create search_log table for tracking memory_search usage
 */
function applyMigration5(db: Database.Database): void {
  db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS search_log (
        id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        query       TEXT NOT NULL,
        mode        TEXT NOT NULL DEFAULT 'fts',
        filters     TEXT NOT NULL DEFAULT '{}',
        result_count INTEGER NOT NULL DEFAULT 0,
        result_ids  TEXT NOT NULL DEFAULT '[]',
        query_time_ms INTEGER NOT NULL DEFAULT 0,
        occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `).run();

    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_search_log_occurred
        ON search_log(occurred_at DESC)
    `).run();
  })();
}

/**
 * Migration v6: Embedding model tracking.
 * - Add embedding_model column to track which model produced the embedding.
 *   Format: "provider:model:dimensions" (e.g. "openai:text-embedding-3-small:1024")
 */
function applyMigration6(db: Database.Database): void {
  db.transaction(() => {
    safeAddColumn(db, "memories", "embedding_model", "TEXT");
  })();
}

/**
 * Migration v7: Drop legacy embedding BLOB column.
 * Embeddings are stored in memories_vec (sqlite-vec) since v1.2.0.
 * The memories.embedding column was never populated by production code.
 */
function applyMigration7(db: Database.Database): void {
  db.transaction(() => {
    safeDropColumn(db, "memories", "embedding");
  })();
}

/**
 * Backfill stemmed_content and stemmed_title for all memories where they are NULL.
 * Runs once after migration v3, or on startup if entries were inserted before v3.
 * Uses Snowball stemmer via stemText() for both Russian and English content.
 */
function backfillStemmedContent(db: Database.Database): void {
  const rows = db.prepare<[], { id: string; content: string; title: string | null }>(
    `SELECT id, content, title FROM memories WHERE stemmed_content IS NULL`
  ).all();

  if (rows.length === 0) return;

  const update = db.prepare(
    `UPDATE memories SET stemmed_content = ?, stemmed_title = ? WHERE id = ?`
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      update.run(
        stemText(row.content),
        row.title ? stemText(row.title) : null,
        row.id
      );
    }
  });

  tx();
}

export { DB_PATH };
