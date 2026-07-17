import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { openDatabase } from "../../db.js";
import type { Embedder } from "../../embedder.js";
import { createVecTable, loadSqliteVec, upsertVec } from "../../vector.js";
import { memoryAdd } from "../memory-add.js";
import { memorySearch } from "../memory-search.js";

const DIMENSIONS = 4;

const sqliteVecAvailable = (() => {
  const probe = openDatabase(":memory:");
  try {
    return loadSqliteVec(probe);
  } finally {
    probe.close();
  }
})();

function vector(a: number, b: number, c = 0, d = 0): Float32Array {
  return new Float32Array([a, b, c, d]);
}

function createStubEmbedder(
  resolve: (text: string) => Float32Array = () => vector(1, 0)
): Embedder {
  return {
    dimensions: DIMENSIONS,
    provider: "test",
    model: "hand-crafted",
    embed: async (text) => resolve(text),
    embedBatch: async (texts) => texts.map(resolve),
  };
}

describe.skipIf(!sqliteVecAvailable)("hybrid and vector search", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    expect(loadSqliteVec(db)).toBe(true);
    createVecTable(db, DIMENSIONS);
  });

  afterEach(() => {
    db.close();
  });

  it("fuses the union of FTS-only and vector-only hits", async () => {
    const ftsOnly = memoryAdd(db, {
      content: "quartz deployment handbook",
      layer: "semantic",
      importance: 1,
    });
    const vectorOnly = memoryAdd(db, {
      content: "unrelated vocabulary",
      layer: "semantic",
      importance: 1,
    });
    upsertVec(db, vectorOnly.id, vector(1, 0));

    const embedder = createStubEmbedder();
    const fts = await memorySearch(db, { query: "quartz", mode: "fts", limit: 5 });
    const hybrid = await memorySearch(db, { query: "quartz", mode: "hybrid", limit: 5 }, embedder);
    const hybridIds = hybrid.memories.map((memory) => memory.id);

    expect(fts.memories.map((memory) => memory.id)).toEqual([ftsOnly.id]);
    expect(hybridIds).toContain(ftsOnly.id);
    expect(hybridIds).toContain(vectorOnly.id);
  });

  it("ranks a hit found by both FTS and vector above single-source hits", async () => {
    const both = memoryAdd(db, {
      title: "Nebula",
      content: "nebula architecture",
      layer: "semantic",
      importance: 1,
    });
    const ftsOnly = memoryAdd(db, {
      content: "nebula operations",
      layer: "semantic",
      importance: 1,
    });
    const vectorOnly = memoryAdd(db, {
      content: "remote concept",
      layer: "semantic",
      importance: 1,
    });
    upsertVec(db, both.id, vector(1, 0));
    upsertVec(db, vectorOnly.id, vector(0.9, 0.1));

    const result = await memorySearch(
      db,
      { query: "nebula", mode: "hybrid", limit: 5 },
      createStubEmbedder()
    );
    const ids = result.memories.map((memory) => memory.id);

    expect(ids[0]).toBe(both.id);
    expect(ids).toEqual(expect.arrayContaining([ftsOnly.id, vectorOnly.id]));
  });

  it("weights a quoted entity sub-query above the unquoted topic ranking", async () => {
    const entity = memoryAdd(db, {
      content: "Atlas reference material",
      layer: "semantic",
      importance: 1,
    });
    const topic = memoryAdd(db, {
      title: "Workflow workflow workflow",
      content: "workflow reference material",
      layer: "semantic",
      importance: 1,
    });
    upsertVec(db, entity.id, vector(1, 0));
    upsertVec(db, topic.id, vector(0, 1));

    const embedder = createStubEmbedder((text) =>
      text === "Atlas" ? vector(1, 0) : vector(0, 1)
    );
    const unquoted = await memorySearch(
      db,
      { query: "workflow Atlas", mode: "hybrid", limit: 5 },
      embedder
    );
    const quoted = await memorySearch(
      db,
      { query: "workflow \"Atlas\"", mode: "hybrid", limit: 5 },
      embedder
    );

    expect(unquoted.memories[0]!.id).toBe(topic.id);
    expect(quoted.memories[0]!.id).toBe(entity.id);
  });

  it("respects layer and entity filters in hybrid mode", async () => {
    const matching = memoryAdd(db, {
      content: "filtered signal",
      layer: "semantic",
      entity_type: "project",
      entity_name: "Atlas",
      importance: 1,
    });
    const wrongLayer = memoryAdd(db, {
      content: "filtered signal",
      layer: "resource",
      entity_type: "project",
      entity_name: "Atlas",
      importance: 1,
    });
    const wrongEntity = memoryAdd(db, {
      content: "filtered signal",
      layer: "semantic",
      entity_type: "project",
      entity_name: "Orion",
      importance: 1,
    });
    for (const id of [matching.id, wrongLayer.id, wrongEntity.id]) {
      upsertVec(db, id, vector(1, 0));
    }

    const result = await memorySearch(
      db,
      {
        query: "filtered",
        mode: "hybrid",
        layers: ["semantic"],
        entity_name: "Atlas",
        limit: 5,
      },
      createStubEmbedder()
    );

    expect(result.memories.map((memory) => memory.id)).toEqual([matching.id]);
  });

  it("returns vector-mode hits in cosine order", async () => {
    const exact = memoryAdd(db, { content: "first", layer: "semantic", importance: 1 });
    const near = memoryAdd(db, { content: "second", layer: "semantic", importance: 1 });
    const far = memoryAdd(db, { content: "third", layer: "semantic", importance: 1 });
    upsertVec(db, exact.id, vector(1, 0));
    upsertVec(db, near.id, vector(0.8, 0.2));
    upsertVec(db, far.id, vector(0, 1));

    const result = await memorySearch(
      db,
      { query: "semantic query", mode: "vector", limit: 3 },
      createStubEmbedder()
    );

    expect(result.memories.map((memory) => memory.id)).toEqual([
      exact.id,
      near.id,
      far.id,
    ]);
  });
});
