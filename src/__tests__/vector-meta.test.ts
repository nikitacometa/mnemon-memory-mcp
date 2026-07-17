import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../db.js";
import type { Embedder } from "../embedder.js";
import { memoryAdd } from "../tools/memory-add.js";
import { memorySearch } from "../tools/memory-search.js";
import {
  createVecTable,
  isVecLoaded,
  loadSqliteVec,
  upsertVec,
} from "../vector.js";

const DIMENSIONS = 4;

const sqliteVecAvailable = (() => {
  const probe = openDatabase(":memory:");
  try {
    return loadSqliteVec(probe);
  } finally {
    probe.close();
  }
})();

function createStubEmbedder(
  model = "model-a",
  dimensions = DIMENSIONS
): Embedder {
  return {
    dimensions,
    provider: "test",
    model,
    embed: async () => new Float32Array([1, 0, 0, 0].slice(0, dimensions)),
    embedBatch: async (texts) =>
      texts.map(() => new Float32Array([1, 0, 0, 0].slice(0, dimensions))),
  };
}

interface VectorIndexMetaRow {
  provider: string;
  model: string;
  dimensions: number;
  created_at: string;
}

describe.skipIf(!sqliteVecAvailable)("vector index metadata", () => {
  let db: Database.Database;
  let tempDir: string | null;

  beforeEach(() => {
    tempDir = null;
    db = openDatabase(":memory:");
    expect(loadSqliteVec(db)).toBe(true);
  });

  afterEach(() => {
    db.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("records provider, model, and dimensions on first creation", () => {
    const embedder = createStubEmbedder();

    createVecTable(db, embedder.dimensions, embedder);

    const row = db.prepare<[], VectorIndexMetaRow>(
      `SELECT provider, model, dimensions, created_at
       FROM vector_index_meta
       WHERE id = 1`
    ).get();
    expect(row).toMatchObject({
      provider: "test",
      model: "model-a",
      dimensions: DIMENSIONS,
    });
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps a matching index usable after reopening the database", async () => {
    const embedder = createStubEmbedder();
    tempDir = mkdtempSync(join(tmpdir(), "mnemon-vector-meta-"));
    const dbPath = join(tempDir, "memory.db");
    db.close();
    db = openDatabase(dbPath);
    expect(loadSqliteVec(db)).toBe(true);
    createVecTable(db, embedder.dimensions, embedder);
    const memory = memoryAdd(db, {
      content: "matching embedding space",
      layer: "semantic",
      importance: 1,
    });
    upsertVec(db, memory.id, new Float32Array([1, 0, 0, 0]));

    db.close();
    db = openDatabase(dbPath);
    expect(loadSqliteVec(db)).toBe(true);
    createVecTable(db, embedder.dimensions, embedder);
    const result = await memorySearch(
      db,
      { query: "matching", mode: "vector", limit: 1 },
      embedder
    );

    expect(isVecLoaded()).toBe(true);
    expect(result.memories.map((item) => item.id)).toEqual([memory.id]);
  });

  it("disables vector search when the model differs at the same dimensions", async () => {
    const original = createStubEmbedder("model-a");
    createVecTable(db, original.dimensions, original);
    const memory = memoryAdd(db, {
      content: "must not be ranked across models",
      layer: "semantic",
    });
    upsertVec(db, memory.id, new Float32Array([1, 0, 0, 0]));
    const changed = createStubEmbedder("model-b");

    createVecTable(db, changed.dimensions, changed);

    expect(isVecLoaded()).toBe(false);
    await expect(
      memorySearch(
        db,
        { query: "models", mode: "vector", limit: 1 },
        changed
      )
    ).rejects.toThrow(/embedding-model mismatch.*model-a.*model-b/i);
    const fts = await memorySearch(db, { query: "ranked", mode: "fts", limit: 1 });
    expect(fts.memories.map((item) => item.id)).toEqual([memory.id]);
  });

  it("disables vector search when dimensions differ on a populated index", async () => {
    const original = createStubEmbedder("model-a", 4);
    createVecTable(db, original.dimensions, original);
    const memory = memoryAdd(db, { content: "indexed at four dims", layer: "semantic" });
    upsertVec(db, memory.id, new Float32Array([1, 0, 0, 0]));
    const changed = createStubEmbedder("model-a", 3);

    createVecTable(db, changed.dimensions, changed);

    expect(isVecLoaded()).toBe(false);
    await expect(
      memorySearch(
        db,
        { query: "dimensions", mode: "vector", limit: 1 },
        changed
      )
    ).rejects.toThrow(/embedding-model mismatch.*:4.*:3/i);
  });

  it("keeps a legacy index usable when its row tags match the current model", async () => {
    // Simulates upgrading a pre-v8 database: vectors exist, metadata does not.
    // Provenance must come from the rows, not from whatever is configured now.
    const embedder = createStubEmbedder("model-a");
    createVecTable(db, embedder.dimensions, embedder);
    const memory = memoryAdd(db, { content: "legacy embedded row", layer: "semantic" });
    upsertVec(db, memory.id, new Float32Array([1, 0, 0, 0]), {
      provider: embedder.provider,
      model: embedder.model,
      dimensions: embedder.dimensions,
    });
    db.prepare(`DELETE FROM vector_index_meta WHERE id = 1`).run();

    createVecTable(db, embedder.dimensions, embedder);

    expect(isVecLoaded()).toBe(true);
    const result = await memorySearch(db, { query: "legacy", mode: "vector", limit: 1 }, embedder);
    expect(result.memories.map((item) => item.id)).toEqual([memory.id]);
  });

  it("disables a legacy index whose row tags name a different model", async () => {
    const original = createStubEmbedder("model-a");
    createVecTable(db, original.dimensions, original);
    const memory = memoryAdd(db, { content: "embedded by the old model", layer: "semantic" });
    upsertVec(db, memory.id, new Float32Array([1, 0, 0, 0]), {
      provider: original.provider,
      model: original.model,
      dimensions: original.dimensions,
    });
    db.prepare(`DELETE FROM vector_index_meta WHERE id = 1`).run();
    const changed = createStubEmbedder("model-b");

    createVecTable(db, changed.dimensions, changed);

    expect(isVecLoaded()).toBe(false);
    await expect(
      memorySearch(db, { query: "old", mode: "vector", limit: 1 }, changed)
    ).rejects.toThrow(/embedding-model mismatch.*model-a.*model-b/i);
  });

  it("stamps provenance on the row in the same write as the vector", () => {
    const embedder = createStubEmbedder("model-a");
    createVecTable(db, embedder.dimensions, embedder);
    const memory = memoryAdd(db, { content: "tagged on write", layer: "semantic" });

    upsertVec(db, memory.id, new Float32Array([1, 0, 0, 0]), {
      provider: embedder.provider,
      model: embedder.model,
      dimensions: embedder.dimensions,
    });

    const row = db.prepare<[string], { embedding_model: string | null }>(
      `SELECT embedding_model FROM memories WHERE id = ?`
    ).get(memory.id);
    expect(row?.embedding_model).toBe("test:model-a:4");
  });

  it("adopts a new embedding space when the index holds no vectors", async () => {
    // Nothing to corrupt in an empty index — switching models before the
    // first embedding is a free choice, not a recovery scenario
    const original = createStubEmbedder("model-a", 4);
    createVecTable(db, original.dimensions, original);
    const changed = createStubEmbedder("model-b", 3);

    createVecTable(db, changed.dimensions, changed);

    expect(isVecLoaded()).toBe(true);
    const row = db.prepare<[], VectorIndexMetaRow>(
      `SELECT provider, model, dimensions, created_at FROM vector_index_meta WHERE id = 1`
    ).get();
    expect(row).toMatchObject({ provider: "test", model: "model-b", dimensions: 3 });

    // The vec table was rebuilt at the new width, so it accepts 3-dim vectors
    const memory = memoryAdd(db, { content: "embedded after the switch", layer: "semantic" });
    upsertVec(db, memory.id, new Float32Array([1, 0, 0]));
    const result = await memorySearch(
      db,
      { query: "switch", mode: "vector", limit: 1 },
      changed
    );
    expect(result.memories.map((item) => item.id)).toEqual([memory.id]);
  });
});
