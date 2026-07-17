/**
 * Performance benchmarks for mnemon-mcp core operations.
 *
 * Corpus: 500 in-memory SQLite entries seeded in beforeAll.
 * Run with: npm run bench
 *
 * Each bench() iteration exercises a single logical operation; vitest bench
 * handles warmup and statistical aggregation (ops/sec, p99 latency).
 */

import { bench, describe, beforeAll, afterAll } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db.js";
import { memoryAdd } from "../tools/memory-add.js";
import { memorySearch } from "../tools/memory-search.js";
import { memoryExport } from "../tools/memory-export.js";
import { memoryInspect } from "../tools/memory-inspect.js";
import type { Layer, EntityType } from "../types.js";

// ---------------------------------------------------------------------------
// Seed corpus
// ---------------------------------------------------------------------------

const CORPUS_SIZE = 500;

/** Weighted layer distribution matching a realistic KB: ~40% semantic, ~30% episodic, ~20% resource, ~10% procedural */
const LAYER_POOL: Layer[] = [
  "semantic", "semantic", "semantic", "semantic",
  "episodic", "episodic", "episodic",
  "resource", "resource",
  "procedural",
];

const ENTITY_TYPES: EntityType[] = ["user", "project", "person", "concept", "file", "rule", "tool"];

const ENTITY_NAMES = [
  "nikita", "mnemon-mcp", "typescript", "sqlite", "claude", "react",
  "human-design", "anya", "dima", "project-alpha", null, null, null,
];

const SCOPES = ["global", "mnemon-mcp", "personal", "work", "research"];

/** Mix of Russian and English content to exercise unicode61 tokenizer */
const CONTENT_TEMPLATES = [
  // English — factual / semantic
  (i: number) => `TypeScript ${i} enables strict type checking and improves developer productivity through advanced generics and conditional types.`,
  (i: number) => `SQLite FTS5 uses BM25 ranking with configurable field weights. Query ${i} demonstrates OR fallback when AND returns zero results.`,
  (i: number) => `Memory entry ${i}: the importance weight formula is bm25_score * (0.5 + 0.5 * importance) to balance relevance with priority.`,
  (i: number) => `Resource reference ${i}: better-sqlite3 is a synchronous SQLite binding for Node.js, ideal for stdio-based MCP transports.`,
  (i: number) => `Procedural rule ${i}: never write to stdout in MCP tools — it breaks the JSON-RPC stdio transport protocol.`,
  // Russian — factual / episodic
  (i: number) => `Запись ${i}: субличности в психологии — внутренние части личности, каждая со своими убеждениями и стратегиями поведения.`,
  (i: number) => `Сессия ${i} (март 2026): обсуждали архитектуру системы памяти, решили использовать FTS5 с тригерами для синхронизации.`,
  (i: number) => `Факт ${i}: человек-дизайн определяет энергетический тип через анализ позиций планет в момент рождения.`,
  (i: number) => `Эпизод ${i}: встреча с командой, приняли решение расширить import scope для улучшения покрытия golden set.`,
  (i: number) => `Концепция ${i}: стемминг Snowball улучшает полнотекстовый поиск за счёт морфологической нормализации русских слов.`,
  // Mixed / technical
  (i: number) => `Migration v${i % 5 + 1}: добавлен partial index на memories(scope, layer) WHERE superseded_by IS NULL для ускорения FTS JOIN.`,
  (i: number) => `Benchmark note ${i}: FTS5 BM25 corpus sensitivity — scores drop ~6 points when corpus size decreases from 900 to 268 active entries.`,
];

const TITLE_TEMPLATES = [
  (i: number) => `TypeScript fact ${i}`,
  (i: number) => `FTS5 insight ${i}`,
  (i: number) => `Memory architecture ${i}`,
  (i: number) => `SQLite note ${i}`,
  (i: number) => `Субличности ${i}`,
  (i: number) => `Сессия ${i}`,
  (i: number) => `Человек-дизайн ${i}`,
  (i: number) => `Архитектурное решение ${i}`,
  (i: number) => `Benchmark ${i}`,
  (_i: number) => null,
];

function pick<T>(arr: T[], index: number): T {
  return arr[index % arr.length]!;
}

function seedCorpus(db: Database.Database, count: number): void {
  // Wrap all inserts in a single transaction — ~10–20x faster than autocommit
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const layer = pick(LAYER_POOL, i * 7);
      const entityType = i % 5 === 0 ? null : pick(ENTITY_TYPES, i);
      const entityName = pick(ENTITY_NAMES, i * 3);
      const scope = pick(SCOPES, i);
      const contentFn = pick(CONTENT_TEMPLATES, i);
      const titleFn = pick(TITLE_TEMPLATES, i);
      const importance = parseFloat(((i % 10) * 0.1).toFixed(1));
      const confidence = parseFloat((0.5 + (i % 5) * 0.1).toFixed(1));

      // Stagger event_at across 2025–2026 for date-filter benchmarks
      const year = i < 250 ? "2025" : "2026";
      const month = String((i % 12) + 1).padStart(2, "0");
      const day = String((i % 28) + 1).padStart(2, "0");
      const eventAt = layer === "episodic" ? `${year}-${month}-${day}T10:00:00Z` : null;

      const input: Record<string, unknown> = {
        content: contentFn(i),
        layer,
        scope,
        importance,
        confidence,
        source: "bench",
      };
      const title = titleFn(i);
      if (title !== null) input["title"] = title;
      if (entityType !== null) input["entity_type"] = entityType;
      if (entityName !== null) input["entity_name"] = entityName;
      if (eventAt !== null) input["event_at"] = eventAt;
      memoryAdd(db, input as unknown as import("../types.js").MemoryAddInput);
    }
  });

  tx();
}

// ---------------------------------------------------------------------------
// Shared database — created once for all benchmarks
// ---------------------------------------------------------------------------

let db: Database.Database;

beforeAll(() => {
  db = openDatabase(":memory:");
  seedCorpus(db, CORPUS_SIZE);
});

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// memory_add — single insert baseline
// ---------------------------------------------------------------------------

describe("memory_add", () => {
  /** Each iteration inserts one memory. Tests raw INSERT + FTS5 trigger + event_log overhead. */
  bench("insert single semantic memory", () => {
    memoryAdd(db, {
      content: "Benchmark insert: TypeScript strict mode enforces noImplicitAny and strictNullChecks.",
      layer: "semantic",
      title: "TS strict mode",
      entity_type: "concept",
      entity_name: "typescript",
      importance: 0.7,
      confidence: 0.9,
      scope: "global",
      source: "bench",
    });
  });

  bench("insert episodic memory with event_at", () => {
    memoryAdd(db, {
      content: "Сессия: обсудили производительность FTS5 на корпусе из 500 записей.",
      layer: "episodic",
      title: "Bench session note",
      event_at: "2026-03-13T12:00:00Z",
      importance: 0.5,
      confidence: 0.8,
      scope: "mnemon-mcp",
      source: "bench",
    });
  });
});

// ---------------------------------------------------------------------------
// memory_search — FTS AND (primary path)
// ---------------------------------------------------------------------------

describe("memory_search / FTS AND", () => {
  /** AND query where both tokens are common enough to return results — exercises the happy path. */
  bench("2-term AND query: 'TypeScript strict'", () => {
    memorySearch(db, {
      query: "TypeScript strict",
      mode: "fts",
      limit: 10,
    });
  });

  bench("2-term AND query with layer filter: 'памяти архитектур'", () => {
    memorySearch(db, {
      query: "памяти архитектур",
      mode: "fts",
      layers: ["semantic", "episodic"],
      limit: 10,
    });
  });

  bench("2-term AND query with entity_name filter", () => {
    memorySearch(db, {
      query: "TypeScript strict",
      mode: "fts",
      entity_name: "typescript",
      limit: 10,
    });
  });

  bench("2-term AND query with scope filter", () => {
    memorySearch(db, {
      query: "FTS5 BM25",
      mode: "fts",
      scope: "global",
      limit: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// memory_search — AND→OR fallback
// ---------------------------------------------------------------------------

describe("memory_search / FTS AND→OR fallback", () => {
  /**
   * Multi-word query designed to produce < limit AND results, triggering OR supplement.
   * Vitest bench calls this hundreds of times — exercises both AND and OR FTS paths.
   */
  bench("4-term query triggering OR fallback: 'субличности убеждения стратегии поведения'", () => {
    memorySearch(db, {
      query: "субличности убеждения стратегии поведения",
      mode: "fts",
      limit: 10,
    });
  });

  bench("5-term English query triggering OR fallback", () => {
    memorySearch(db, {
      query: "snowball stemmer morphological normalization corpus",
      mode: "fts",
      limit: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// memory_search — exact mode (LIKE substring)
// ---------------------------------------------------------------------------

describe("memory_search / exact mode", () => {
  /** LIKE %...% on 500-row corpus — no FTS, full table scan with index assist. */
  bench("exact substring: 'BM25'", () => {
    memorySearch(db, {
      query: "BM25",
      mode: "exact",
      limit: 10,
    });
  });

  bench("exact substring Russian: 'Snowball'", () => {
    memorySearch(db, {
      query: "Snowball",
      mode: "exact",
      limit: 10,
    });
  });

  bench("exact substring with layer filter", () => {
    memorySearch(db, {
      query: "importance",
      mode: "exact",
      layers: ["semantic"],
      limit: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// memory_search — date range filter
// ---------------------------------------------------------------------------

describe("memory_search / date filters", () => {
  bench("FTS + date_from (2026 only)", () => {
    memorySearch(db, {
      query: "сессия решение",
      mode: "fts",
      date_from: "2026-01-01T00:00:00Z",
      limit: 10,
    });
  });

  bench("FTS + full date range 2025-Q4", () => {
    memorySearch(db, {
      query: "архитектур памяти",
      mode: "fts",
      date_from: "2025-10-01T00:00:00Z",
      date_to: "2025-12-31T23:59:59Z",
      limit: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// memory_export — full corpus serialization
// ---------------------------------------------------------------------------

describe("memory_export", () => {
  /** JSON export of full active corpus — measures SELECT + JSON.stringify overhead. */
  bench("export all 500 entries as JSON", () => {
    memoryExport(db, {
      format: "json",
      limit: CORPUS_SIZE,
    });
  });

  bench("export all 500 entries as markdown", () => {
    memoryExport(db, {
      format: "markdown",
      limit: CORPUS_SIZE,
    });
  });

  bench("export all 500 entries as claude-md", () => {
    memoryExport(db, {
      format: "claude-md",
      limit: CORPUS_SIZE,
    });
  });

  bench("export semantic layer only as JSON", () => {
    memoryExport(db, {
      format: "json",
      layers: ["semantic"],
      limit: CORPUS_SIZE,
    });
  });

  bench("export with scope filter as JSON", () => {
    memoryExport(db, {
      format: "json",
      scope: "global",
      limit: CORPUS_SIZE,
    });
  });
});

// ---------------------------------------------------------------------------
// memory_inspect — layer statistics
// ---------------------------------------------------------------------------

describe("memory_inspect / layer stats", () => {
  /** Aggregate COUNT+AVG per layer + top-5 entities per layer — 4 subqueries total. */
  bench("full layer stats (all layers)", () => {
    memoryInspect(db, {});
  });

  bench("layer stats filtered to semantic", () => {
    memoryInspect(db, { layer: "semantic" });
  });

  bench("layer stats filtered by entity_name", () => {
    memoryInspect(db, { entity_name: "typescript" });
  });
});
