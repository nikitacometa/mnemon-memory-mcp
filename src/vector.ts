/**
 * sqlite-vec integration for optional vector search.
 *
 * sqlite-vec is loaded dynamically — if not installed, vector features are
 * silently disabled. All functions check `isVecLoaded()` before operating.
 */

import type Database from "better-sqlite3";
import { createRequire } from "node:module";
import type { Embedder } from "./embedder.js";

const require = createRequire(import.meta.url);

// Track the db instance that has sqlite-vec loaded.
// Single-db assumption holds for MCP (one server = one db).
let vecDb: Database.Database | null = null;
let vecUnavailableReason: string | null = null;

type EmbedderMetadata = Pick<Embedder, "provider" | "model">;

interface VectorIndexMetaRow {
  provider: string;
  model: string;
  dimensions: number;
}

/**
 * Try to load sqlite-vec extension into the database connection.
 * Returns true if loaded, false if extension not available.
 */
export function loadSqliteVec(db: Database.Database): boolean {
  try {
    const sqliteVec = require("sqlite-vec") as {
      load: (db: Database.Database) => void;
    };
    sqliteVec.load(db);
    vecDb = db;
    vecUnavailableReason = null;
    return true;
  } catch {
    vecDb = null;
    vecUnavailableReason = null;
    return false;
  }
}

export function isVecLoaded(): boolean {
  return vecDb !== null;
}

export function getVecUnavailableReason(): string | null {
  return vecUnavailableReason;
}

/** Provenance tag recorded per memory by the embedding paths. */
function modelTag(meta: { provider: string; model: string; dimensions: number }): string {
  return `${meta.provider}:${meta.model}:${meta.dimensions}`;
}

/**
 * Model tags on already-embedded rows that disagree with `expected`.
 * Rows with no tag are inconclusive, not foreign — they predate tagging, and
 * refusing on them would break every legacy install that never switched models.
 */
function legacyForeignModels(db: Database.Database, expected: string): string[] {
  try {
    const rows = db.prepare<[], { model: string | null }>(
      `SELECT DISTINCT m.embedding_model AS model
       FROM memories_vec v
       JOIN memories m ON m.id = v.memory_id`
    ).all();
    return rows
      .map((r) => r.model)
      .filter((model): model is string => model !== null && model !== expected);
  } catch {
    return [];
  }
}

/**
 * Create the vec0 virtual table for memory embeddings.
 * Must be called after loadSqliteVec() succeeds.
 */
export function createVecTable(
  db: Database.Database,
  dimensions: number,
  embedder: EmbedderMetadata
): void {
  if (!vecDb) return;

  const current = {
    provider: embedder.provider,
    model: embedder.model,
    dimensions,
  };
  const stored = db.prepare<[], VectorIndexMetaRow>(
    `SELECT provider, model, dimensions
     FROM vector_index_meta
     WHERE id = 1`
  ).get();

  const mismatched =
    stored !== undefined &&
    (
      stored.provider !== current.provider ||
      stored.model !== current.model ||
      stored.dimensions !== current.dimensions
    );

  // Databases predating this metadata table can already hold vectors. Trusting
  // the current config as their provenance would bless a model switch made
  // during the upgrade — so recover provenance from the per-row model tags
  // instead, and refuse only when they actually disagree.
  if (!stored && vecCount(db) > 0) {
    const foreign = legacyForeignModels(db, modelTag(current));
    if (foreign.length > 0) {
      vecUnavailableReason =
        `embedding-model mismatch: index built with ${foreign.join(", ")}, ` +
        `current=${modelTag(current)}. ` +
        "Re-run `npm run embed:backfill --force` to rebuild the index; FTS remains available.";
      console.error(`[mnemon-mcp] ${vecUnavailableReason}`);
      vecDb = null;
      return;
    }
  }

  // Only a POPULATED index is at risk: mixing vectors from two embedding
  // spaces makes cosine distance meaningless with no error to show for it.
  // An empty index has nothing to corrupt, so adopt the new space instead of
  // making the user clear an index that holds nothing.
  if (mismatched && vecCount(db) > 0) {
    vecUnavailableReason =
      `embedding-model mismatch: index=${stored.provider}:${stored.model}:${stored.dimensions}, ` +
      `current=${current.provider}:${current.model}:${current.dimensions}. ` +
      "Clear the vector index, then re-run `npm run embed:backfill --force`; FTS remains available.";
    console.error(`[mnemon-mcp] ${vecUnavailableReason}`);
    vecDb = null;
    return;
  }

  // A dimension change needs a real rebuild — CREATE ... IF NOT EXISTS would
  // silently keep the old column width and reject every new vector
  if (mismatched && stored.dimensions !== current.dimensions) {
    db.exec(`DROP TABLE IF EXISTS memories_vec`);
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
      memory_id TEXT PRIMARY KEY,
      content_embedding float[${dimensions}] distance_metric=cosine
    )
  `);

  if (!stored) {
    db.prepare(
      `INSERT INTO vector_index_meta(id, provider, model, dimensions)
       VALUES (1, ?, ?, ?)`
    ).run(current.provider, current.model, current.dimensions);
  } else if (mismatched) {
    db.prepare(
      `UPDATE vector_index_meta
       SET provider = ?, model = ?, dimensions = ?,
           created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = 1`
    ).run(current.provider, current.model, current.dimensions);
  }
}

/**
 * Insert or replace a vector for a memory.
 *
 * Pass `meta` on every production path: it stamps the row's provenance in the
 * same transaction as the vector, so `memories.embedding_model` can never
 * disagree with what is actually in the index. Tests that hand-craft vectors
 * may omit it.
 */
export function upsertVec(
  db: Database.Database,
  memoryId: string,
  embedding: Float32Array,
  meta?: EmbedderMetadata & { dimensions: number }
): void {
  if (!vecDb) return;
  db.transaction(() => {
    db.prepare(
      "INSERT OR REPLACE INTO memories_vec(memory_id, content_embedding) VALUES (?, ?)"
    ).run(memoryId, embedding);
    if (meta) {
      db.prepare("UPDATE memories SET embedding_model = ? WHERE id = ?").run(
        modelTag(meta),
        memoryId
      );
    }
  })();
}

/** Delete a vector when a memory is deleted. */
export function deleteVec(db: Database.Database, memoryId: string): void {
  if (!vecDb) return;
  db.prepare("DELETE FROM memories_vec WHERE memory_id = ?").run(memoryId);
}

/**
 * Invalidate an embedding whose source text changed. Call this inside the same
 * transaction as the content mutation so a committed memory can never retain
 * a vector (or provenance tag) for its previous text.
 */
export function invalidateVec(db: Database.Database, memoryId: string): void {
  if (!vecDb) return;
  db.prepare("DELETE FROM memories_vec WHERE memory_id = ?").run(memoryId);
  db.prepare("UPDATE memories SET embedding_model = NULL WHERE id = ?").run(memoryId);
}

/** KNN search — returns memory IDs sorted by cosine similarity (ascending distance). */
export function knnSearch(
  db: Database.Database,
  queryVec: Float32Array,
  k: number,
  excludeSuperseded: boolean = true
): Array<{ memory_id: string; distance: number }> {
  if (!vecDb) return [];

  if (excludeSuperseded) {
    return db
      .prepare<
        [Float32Array, number],
        { memory_id: string; distance: number }
      >(
        `SELECT v.memory_id, v.distance
         FROM memories_vec v
         JOIN memories m ON m.id = v.memory_id
         WHERE v.content_embedding MATCH ?
           AND k = ?
           AND m.superseded_by IS NULL
         ORDER BY v.distance`
      )
      .all(queryVec, k);
  }

  return db
    .prepare<
      [Float32Array, number],
      { memory_id: string; distance: number }
    >(
      `SELECT memory_id, distance
       FROM memories_vec
       WHERE content_embedding MATCH ?
         AND k = ?
       ORDER BY distance`
    )
    .all(queryVec, k);
}

/** Check how many memories have embeddings. */
export function vecCount(db: Database.Database): number {
  if (!vecDb) return 0;
  try {
    const row = db.prepare<[], { cnt: number }>(
      "SELECT count(*) as cnt FROM memories_vec"
    ).get();
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}
