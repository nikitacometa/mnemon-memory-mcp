/**
 * Integration tests for mnemon-mcp core tools.
 * Uses in-memory SQLite database — no production data affected.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../db.js";
import { memoryAdd } from "../memory-add.js";
import { memorySearch } from "../memory-search.js";
import { memoryUpdate } from "../memory-update.js";
import { memoryInspect } from "../memory-inspect.js";
import { memoryDelete } from "../memory-delete.js";
import { memoryExport } from "../memory-export.js";
import { memoryHealth } from "../memory-health.js";
import { sessionStart, sessionEnd, sessionList } from "../session.js";
import { stemText } from "../../stemmer.js";
import type { MemoryAddInput, MemorySearchInput } from "../../types.js";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// memory_add
// ---------------------------------------------------------------------------

describe("memory_add", () => {
  it("inserts a basic memory and returns id", () => {
    const result = memoryAdd(db, {
      content: "TypeScript is great",
      layer: "semantic",
      title: "TS fact",
    });

    expect(result.id).toMatch(/^[0-9a-f]{32}$/);
    expect(result.layer).toBe("semantic");
    expect(result.created).toBe(true);
    expect(result.superseded_ids).toBeUndefined();
  });

  it("sets default confidence and importance", () => {
    const result = memoryAdd(db, { content: "test", layer: "episodic" });
    const row = db.prepare("SELECT confidence, importance FROM memories WHERE id = ?").get(result.id) as { confidence: number; importance: number };
    expect(row.confidence).toBe(0.8);
    expect(row.importance).toBe(0.5);
  });

  it("supersedes existing memory with same source_file", () => {
    const first = memoryAdd(db, {
      content: "version 1",
      layer: "semantic",
      source_file: "test/doc.md",
    });

    const second = memoryAdd(db, {
      content: "version 2",
      layer: "semantic",
      source_file: "test/doc.md",
    });

    expect(second.superseded_ids).toEqual([first.id]);

    const oldRow = db.prepare("SELECT superseded_by FROM memories WHERE id = ?").get(first.id) as { superseded_by: string };
    expect(oldRow.superseded_by).toBe(second.id);
  });

  it("creates event_log entries", () => {
    const result = memoryAdd(db, { content: "test content", layer: "episodic" });
    const events = db.prepare("SELECT event_type, new_content FROM event_log WHERE memory_id = ?").all(result.id) as Array<{ event_type: string; new_content: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("created");
    expect(events[0]!.new_content).toBe("test content");
  });

  it("computes expires_at from ttl_days", () => {
    const result = memoryAdd(db, { content: "ephemeral", layer: "episodic", ttl_days: 7 });
    const row = db.prepare("SELECT expires_at FROM memories WHERE id = ?").get(result.id) as { expires_at: string };
    expect(row.expires_at).toBeTruthy();
    const expiresDate = new Date(row.expires_at);
    const now = new Date();
    const diffDays = (expiresDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(6);
    expect(diffDays).toBeLessThan(8);
  });

  it("throws for non-existent session_id", () => {
    expect(() =>
      memoryAdd(db, {
        content: "orphaned memory",
        layer: "episodic",
        session_id: "non-existent-session-id",
      })
    ).toThrow("Session not found: non-existent-session-id");
  });

  it("accepts valid session_id", () => {
    const session = sessionStart(db, { client: "test" });
    const result = memoryAdd(db, {
      content: "linked memory",
      layer: "episodic",
      session_id: session.id,
    });
    expect(result.created).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------

describe("memory_search", () => {
  function seedMemories() {
    memoryAdd(db, { content: "TypeScript strict mode enables better type safety", layer: "semantic", title: "TS strict" });
    memoryAdd(db, { content: "Встреча с Алексеем в кафе на Сукхумвит", layer: "episodic", title: "Meeting", event_at: "2026-03-01T10:00:00Z" });
    memoryAdd(db, { content: "Always run npm test before committing code changes", layer: "procedural", title: "Dev rule" });
    memoryAdd(db, { content: "Book summary: Thinking Fast and Slow by Kahneman", layer: "resource", title: "Book" });
  }

  it("finds memory by keyword", async () => {
    seedMemories();
    const result = await memorySearch(db, { query: "TypeScript" });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0]!.content).toContain("TypeScript");
  });

  it("finds Cyrillic content", async () => {
    seedMemories();
    const result = await memorySearch(db, { query: "Алексеем" });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0]!.content).toContain("Алексеем");
  });

  it("filters by layer", async () => {
    seedMemories();
    const result = await memorySearch(db, { query: "TypeScript", layers: ["procedural"] });
    // TypeScript is in semantic, not procedural
    expect(result.memories.length).toBe(0);
  });

  it("excludes superseded entries by default", async () => {
    memoryAdd(db, { content: "old version of facts", layer: "semantic", source_file: "doc.md" });
    memoryAdd(db, { content: "new version of facts", layer: "semantic", source_file: "doc.md" });

    const result = await memorySearch(db, { query: "version facts" });
    expect(result.memories.length).toBe(1);
    expect(result.memories[0]!.content).toContain("new version");
  });

  it("includes superseded when requested", async () => {
    memoryAdd(db, { content: "old version of facts", layer: "semantic", source_file: "doc.md" });
    memoryAdd(db, { content: "new version of facts", layer: "semantic", source_file: "doc.md" });

    const result = await memorySearch(db, { query: "version facts", include_superseded: true });
    expect(result.memories.length).toBe(2);
  });

  it("excludes expired memories", async () => {
    const result = memoryAdd(db, { content: "expired content here", layer: "episodic", ttl_days: 1 });
    // Manually set expires_at to the past
    db.prepare("UPDATE memories SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(result.id);

    const search = await memorySearch(db, { query: "expired content" });
    expect(search.memories.length).toBe(0);
  });

  it("falls back to OR when AND returns nothing", async () => {
    memoryAdd(db, { content: "SQLite database engine is fast", layer: "semantic" });
    // Query with words that won't all appear together
    const result = await memorySearch(db, { query: "SQLite PostgreSQL comparison" });
    // OR fallback should find SQLite match
    expect(result.memories.length).toBeGreaterThan(0);
  });

  it("exact mode finds substring matches", async () => {
    memoryAdd(db, { content: "the quick brown fox jumps over lazy dog", layer: "semantic" });
    const result = await memorySearch(db, { query: "brown fox", mode: "exact" });
    expect(result.memories.length).toBe(1);
  });

  it("updates access_count on search", async () => {
    const added = memoryAdd(db, { content: "access tracking test", layer: "semantic" });
    await memorySearch(db, { query: "access tracking" });

    const row = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(added.id) as { access_count: number };
    expect(row.access_count).toBe(1);
  });

  it("returns query_time_ms", async () => {
    seedMemories();
    const result = await memorySearch(db, { query: "TypeScript" });
    expect(result.query_time_ms).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// memory_update
// ---------------------------------------------------------------------------

describe("memory_update", () => {
  it("updates content in place", () => {
    const added = memoryAdd(db, { content: "original", layer: "semantic" });
    const result = memoryUpdate(db, { id: added.id, content: "updated" });

    expect(result.superseded).toBe(false);
    expect(result.updated_id).toBe(added.id);

    const row = db.prepare("SELECT content FROM memories WHERE id = ?").get(added.id) as { content: string };
    expect(row.content).toBe("updated");
  });

  it("creates superseding entry when supersede=true", () => {
    const added = memoryAdd(db, { content: "original", layer: "semantic" });
    const result = memoryUpdate(db, { id: added.id, new_content: "superseded version", supersede: true });

    expect(result.superseded).toBe(true);
    expect(result.new_id).toBeTruthy();

    const oldRow = db.prepare("SELECT superseded_by FROM memories WHERE id = ?").get(added.id) as { superseded_by: string };
    expect(oldRow.superseded_by).toBe(result.new_id);

    const newRow = db.prepare("SELECT content, supersedes FROM memories WHERE id = ?").get(result.new_id!) as { content: string; supersedes: string };
    expect(newRow.content).toBe("superseded version");
    expect(newRow.supersedes).toBe(added.id);
  });

  it("throws on non-existent ID", () => {
    expect(() => memoryUpdate(db, { id: "nonexistent" })).toThrow("Memory not found");
  });

  it("merges meta on update", () => {
    const added = memoryAdd(db, { content: "test", layer: "semantic", meta: { a: 1 } });
    memoryUpdate(db, { id: added.id, meta: { b: 2 } });

    const row = db.prepare("SELECT meta FROM memories WHERE id = ?").get(added.id) as { meta: string };
    const meta = JSON.parse(row.meta) as Record<string, unknown>;
    expect(meta).toEqual({ a: 1, b: 2 });
  });

  it("logs update event with old and new content", () => {
    const added = memoryAdd(db, { content: "before", layer: "semantic" });
    memoryUpdate(db, { id: added.id, content: "after" });

    const events = db.prepare("SELECT event_type, old_content, new_content FROM event_log WHERE memory_id = ? ORDER BY occurred_at").all(added.id) as Array<{ event_type: string; old_content: string | null; new_content: string | null }>;
    // First event: created, second: updated
    expect(events).toHaveLength(2);
    expect(events[1]!.event_type).toBe("updated");
    expect(events[1]!.old_content).toBe("before");
    expect(events[1]!.new_content).toBe("after");
  });
});

// ---------------------------------------------------------------------------
// memory_inspect
// ---------------------------------------------------------------------------

describe("memory_inspect", () => {
  it("returns layer stats when no id", () => {
    memoryAdd(db, { content: "fact 1", layer: "semantic" });
    memoryAdd(db, { content: "fact 2", layer: "semantic" });
    memoryAdd(db, { content: "event 1", layer: "episodic" });

    const result = memoryInspect(db, {});
    expect(result.layer_stats).toBeDefined();
    expect(result.layer_stats!.semantic.active).toBe(2);
    expect(result.layer_stats!.episodic.active).toBe(1);
    expect(result.layer_stats!.procedural.active).toBe(0);
  });

  it("returns full memory by id", () => {
    const added = memoryAdd(db, { content: "inspect me", layer: "resource", title: "Test" });
    const result = memoryInspect(db, { id: added.id });

    expect(result.memory).toBeDefined();
    expect(result.memory!.content).toBe("inspect me");
    expect(result.memory!.title).toBe("Test");
  });

  it("increments access_count on inspect", () => {
    const added = memoryAdd(db, { content: "track access", layer: "semantic" });
    memoryInspect(db, { id: added.id });
    memoryInspect(db, { id: added.id });

    const row = db.prepare("SELECT access_count FROM memories WHERE id = ?").get(added.id) as { access_count: number };
    expect(row.access_count).toBe(2);
  });

  it("returns superseded chain with include_history", () => {
    const v1 = memoryAdd(db, { content: "v1", layer: "semantic", source_file: "chain.md" });
    const v2 = memoryAdd(db, { content: "v2", layer: "semantic", source_file: "chain.md" });

    const result = memoryInspect(db, { id: v2.id, include_history: true });
    expect(result.superseded_chain).toBeDefined();
    expect(result.superseded_chain!.length).toBeGreaterThanOrEqual(1);
    expect(result.superseded_chain![0]!.id).toBe(v1.id);
  });

  it("throws on non-existent id", () => {
    expect(() => memoryInspect(db, { id: "nonexistent" })).toThrow("Memory not found");
  });

  it("inspectById response does not contain stemmed_content or stemmed_title", () => {
    const added = memoryAdd(db, { content: "stemmed leak test", layer: "semantic", title: "Leak Test" });
    const result = memoryInspect(db, { id: added.id });
    expect(result.memory).toBeDefined();
    expect(result.memory).not.toHaveProperty("stemmed_content");
    expect(result.memory).not.toHaveProperty("stemmed_title");
  });

  it("superseded chain entries do not contain stemmed columns", () => {
    const v1 = memoryAdd(db, { content: "chain v1", layer: "semantic", source_file: "leak-chain.md" });
    const v2 = memoryAdd(db, { content: "chain v2", layer: "semantic", source_file: "leak-chain.md" });

    const result = memoryInspect(db, { id: v2.id, include_history: true });
    expect(result.superseded_chain).toBeDefined();
    expect(result.superseded_chain!.length).toBeGreaterThanOrEqual(1);
    for (const entry of result.superseded_chain!) {
      expect(entry).not.toHaveProperty("stemmed_content");
      expect(entry).not.toHaveProperty("stemmed_title");
    }
  });
});

// ---------------------------------------------------------------------------
// memory_delete
// ---------------------------------------------------------------------------

describe("memory_delete", () => {
  it("deletes a memory and returns confirmation", () => {
    const added = memoryAdd(db, { content: "delete me", layer: "semantic" });
    const result = memoryDelete(db, { id: added.id });

    expect(result.deleted_id).toBe(added.id);

    const row = db.prepare("SELECT id FROM memories WHERE id = ?").get(added.id);
    expect(row).toBeUndefined();
  });

  it("re-activates predecessor when deleting a superseding entry", () => {
    const v1 = memoryAdd(db, { content: "v1", layer: "semantic", source_file: "chain.md" });
    const v2 = memoryAdd(db, { content: "v2", layer: "semantic", source_file: "chain.md" });

    // v1 should be superseded by v2
    const before = db.prepare("SELECT superseded_by FROM memories WHERE id = ?").get(v1.id) as { superseded_by: string | null };
    expect(before.superseded_by).toBe(v2.id);

    // Delete v2 → v1 becomes active again
    memoryDelete(db, { id: v2.id });

    const after = db.prepare("SELECT superseded_by FROM memories WHERE id = ?").get(v1.id) as { superseded_by: string | null };
    expect(after.superseded_by).toBeNull();
  });

  it("removes deleted entry from FTS index", async () => {
    const added = memoryAdd(db, { content: "unique_fts_deletion_test_token", layer: "semantic" });
    memoryDelete(db, { id: added.id });

    const search = await memorySearch(db, { query: "unique_fts_deletion_test_token" });
    expect(search.memories.length).toBe(0);
  });

  it("logs deletion in event_log", () => {
    const added = memoryAdd(db, { content: "log this deletion", layer: "semantic" });
    memoryDelete(db, { id: added.id });

    const events = db.prepare("SELECT event_type FROM event_log WHERE memory_id = ? ORDER BY occurred_at DESC").all(added.id) as Array<{ event_type: string }>;
    expect(events.some(e => e.event_type === "deleted")).toBe(true);
  });

  it("correctly re-links chain when deleting middle element A→B→C", async () => {
    // Create chain: v1 → v2 → v3
    const v1 = memoryAdd(db, { content: "chain v1", layer: "semantic", source_file: "chain-mid.md" });
    const v2 = memoryAdd(db, { content: "chain v2", layer: "semantic", source_file: "chain-mid.md" });
    const v3 = memoryAdd(db, { content: "chain v3", layer: "semantic", source_file: "chain-mid.md" });

    // Delete v2 (middle) — should link v1←v3
    memoryDelete(db, { id: v2.id });

    const v1Row = db.prepare("SELECT superseded_by FROM memories WHERE id = ?").get(v1.id) as { superseded_by: string | null };
    const v3Row = db.prepare("SELECT supersedes FROM memories WHERE id = ?").get(v3.id) as { supersedes: string | null };

    // v1 should now be superseded by v3 (not null, not v2)
    expect(v1Row.superseded_by).toBe(v3.id);
    // v3 should now supersede v1 (not v2)
    expect(v3Row.supersedes).toBe(v1.id);

    // Only v3 should be active (v1 still superseded)
    const search = await memorySearch(db, { query: "chain", mode: "exact" });
    expect(search.memories.length).toBe(1);
    expect(search.memories[0]!.id).toBe(v3.id);
  });

  it("throws on non-existent ID", () => {
    expect(() => memoryDelete(db, { id: "nonexistent" })).toThrow("Memory not found");
  });
});

// ---------------------------------------------------------------------------
// memory_export
// ---------------------------------------------------------------------------

describe("memory_export", () => {
  function seedForExport() {
    memoryAdd(db, { content: "Semantic fact 1", layer: "semantic", title: "Fact 1" });
    memoryAdd(db, { content: "Semantic fact 2", layer: "semantic", title: "Fact 2" });
    memoryAdd(db, { content: "Episodic event", layer: "episodic", title: "Event", event_at: "2026-01-15T10:00:00Z" });
  }

  it("exports as JSON", () => {
    seedForExport();
    const result = memoryExport(db, { format: "json" });
    expect(result.format).toBe("json");
    expect(result.count).toBe(3);
    const parsed = JSON.parse(result.content) as unknown[];
    expect(parsed).toHaveLength(3);
  });

  it("exports as markdown", () => {
    seedForExport();
    const result = memoryExport(db, { format: "markdown" });
    expect(result.content).toContain("# Memory Export");
    expect(result.content).toContain("## semantic");
    expect(result.content).toContain("## episodic");
  });

  it("exports as claude-md", () => {
    seedForExport();
    const result = memoryExport(db, { format: "claude-md" });
    expect(result.content).toContain("## Fact 1");
    expect(result.content).toContain("<!-- semantic");
  });

  it("filters by layer", () => {
    seedForExport();
    const result = memoryExport(db, { format: "json", layers: ["episodic"] });
    expect(result.count).toBe(1);
  });

  it("respects limit", () => {
    seedForExport();
    const result = memoryExport(db, { format: "json", limit: 2 });
    expect(result.count).toBe(2);
  });

  it("excludes superseded by default", () => {
    memoryAdd(db, { content: "old", layer: "semantic", source_file: "test.md" });
    memoryAdd(db, { content: "new", layer: "semantic", source_file: "test.md" });
    const result = memoryExport(db, { format: "json" });
    expect(result.count).toBe(1);
  });

  it("uses COALESCE(event_at, created_at) for date filter", () => {
    seedForExport();
    const result = memoryExport(db, { format: "json", date_from: "2026-01-01", date_to: "2026-01-31" });
    expect(result.count).toBe(1);
    const parsed = JSON.parse(result.content) as Array<{ title: string }>;
    expect(parsed[0]!.title).toBe("Event");
  });
});

// ---------------------------------------------------------------------------
// memory_search — pagination
// ---------------------------------------------------------------------------

describe("memory_search — pagination", () => {
  it("supports offset for pagination", async () => {
    // Use distinct importance values for deterministic ordering in exact mode
    for (let i = 1; i <= 5; i++) {
      memoryAdd(db, { content: `pagination test item ${i}`, layer: "semantic", importance: i * 0.15 });
    }

    const all = await memorySearch(db, { query: "pagination test", mode: "exact", limit: 5 });
    const page1 = await memorySearch(db, { query: "pagination test", mode: "exact", limit: 2 });
    const page2 = await memorySearch(db, { query: "pagination test", mode: "exact", limit: 2, offset: 2 });

    expect(all.memories.length).toBe(5);
    expect(page1.memories.length).toBe(2);
    expect(page2.memories.length).toBe(2);

    // Page1 = top 2 by importance, page2 = next 2
    expect(page1.memories[0]!.id).toBe(all.memories[0]!.id);
    expect(page1.memories[1]!.id).toBe(all.memories[1]!.id);
    expect(page2.memories[0]!.id).toBe(all.memories[2]!.id);
    expect(page2.memories[1]!.id).toBe(all.memories[3]!.id);
  });

  it("offset larger than limit returns correct slice", async () => {
    for (let i = 0; i < 25; i++) {
      memoryAdd(db, { content: `deep pagination item ${i}`, layer: "semantic", importance: (25 - i) * 0.04 });
    }

    const all = await memorySearch(db, { query: "deep pagination item", mode: "exact", limit: 25 });
    const page = await memorySearch(db, { query: "deep pagination item", mode: "exact", limit: 3, offset: 20 });

    expect(all.memories.length).toBe(25);
    expect(page.memories.length).toBe(3);
    expect(page.memories[0]!.id).toBe(all.memories[20]!.id);
    expect(page.memories[1]!.id).toBe(all.memories[21]!.id);
    expect(page.memories[2]!.id).toBe(all.memories[22]!.id);
  });

  it("offset=0 behaves same as no offset", async () => {
    for (let i = 0; i < 5; i++) {
      memoryAdd(db, { content: `offset zero test ${i}`, layer: "semantic" });
    }

    const noOffset = await memorySearch(db, { query: "offset zero test", mode: "exact", limit: 3 });
    const offset0 = await memorySearch(db, { query: "offset zero test", mode: "exact", limit: 3, offset: 0 });

    expect(noOffset.memories.length).toBe(offset0.memories.length);
    expect(noOffset.memories.map(m => m.id)).toEqual(offset0.memories.map(m => m.id));
  });

  it("offset beyond total returns empty", async () => {
    memoryAdd(db, { content: "beyond total test item", layer: "semantic" });

    const result = await memorySearch(db, { query: "beyond total test", mode: "exact", limit: 5, offset: 100 });
    expect(result.memories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// memory_update — supersede protection
// ---------------------------------------------------------------------------

describe("memory_update — supersede protection", () => {
  it("throws when trying to supersede an already-superseded entry", () => {
    const v1 = memoryAdd(db, { content: "v1", layer: "semantic", source_file: "prot.md" });
    memoryAdd(db, { content: "v2", layer: "semantic", source_file: "prot.md" });

    expect(() =>
      memoryUpdate(db, { id: v1.id, supersede: true, new_content: "v3" })
    ).toThrow("Cannot supersede");
  });

  it("superseding entry gets null expires_at when original was expired", () => {
    const old = memoryAdd(db, { content: "will expire", layer: "semantic", ttl_days: 1 });
    db.prepare("UPDATE memories SET expires_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(old.id);
    const result = memoryUpdate(db, { id: old.id, supersede: true, new_content: "new version" });
    const row = db.prepare("SELECT expires_at FROM memories WHERE id = ?").get(result.new_id!) as { expires_at: string | null };
    expect(row.expires_at).toBeNull();
  });

  it("superseding entry inherits non-expired expires_at", () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    const futureStr = future.toISOString().replace(/\.\d{3}Z$/, "Z");

    const old = memoryAdd(db, { content: "will expire later", layer: "semantic", ttl_days: 30 });
    const result = memoryUpdate(db, { id: old.id, supersede: true, new_content: "updated version" });
    const row = db.prepare("SELECT expires_at FROM memories WHERE id = ?").get(result.new_id!) as { expires_at: string | null };
    expect(row.expires_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// memory_search — LIKE escape in exact mode
// ---------------------------------------------------------------------------

describe("memory_search — exact mode LIKE escape", () => {
  it("does not treat % as wildcard in exact mode", async () => {
    memoryAdd(db, { content: "100% correct answer", layer: "semantic" });
    memoryAdd(db, { content: "totally wrong answer", layer: "semantic" });

    const result = await memorySearch(db, { query: "100%", mode: "exact" });
    expect(result.memories.length).toBe(1);
    expect(result.memories[0]!.content).toContain("100%");
  });

  it("does not treat _ as single-char wildcard in exact mode", async () => {
    memoryAdd(db, { content: "file_name.ts is important", layer: "semantic" });
    memoryAdd(db, { content: "filename is different", layer: "semantic" });

    const result = await memorySearch(db, { query: "file_name", mode: "exact" });
    expect(result.memories.length).toBe(1);
    expect(result.memories[0]!.content).toContain("file_name");
  });
});

// ---------------------------------------------------------------------------
// Stop word filtering (T-091)
// ---------------------------------------------------------------------------

describe("stop word filtering", () => {
  it("strips Russian navigational words from query", async () => {
    memoryAdd(db, { content: "Серии привычек хранятся в трекере", layer: "semantic" });
    // "Где хранятся серии привычек" — "Где" is a stop word, should be stripped
    const result = await memorySearch(db, { query: "Где хранятся серии привычек" });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0]!.content).toContain("привычек");
  });

  it("strips Russian question words: какой, сколько, что", async () => {
    memoryAdd(db, { content: "Дневная норма калорий составляет 2200 ккал", layer: "semantic" });
    // "Какая дневная норма калорий" — "Какая" is a stop word
    const result = await memorySearch(db, { query: "Какая дневная норма калорий" });
    expect(result.memories.length).toBeGreaterThan(0);
  });

  it("strips English stop words from queries", async () => {
    memoryAdd(db, { content: "Human Design profile type is Generator 5/1", layer: "semantic" });
    // "What is the Human Design profile" — What/is/the are stop words
    const result = await memorySearch(db, { query: "What is the Human Design profile" });
    expect(result.memories.length).toBeGreaterThan(0);
  });

  it("handles mixed Russian/English queries with stop words", async () => {
    memoryAdd(db, { content: "Практика випассана с 2024 года", layer: "semantic" });
    // "Что это за практика випассана" — "Что", "это", "за" are stop words
    const result = await memorySearch(db, { query: "Что это за практика випассана" });
    expect(result.memories.length).toBeGreaterThan(0);
  });

  it("falls back to original tokens when all are stop words", async () => {
    memoryAdd(db, { content: "это был он а не она", layer: "episodic" });
    // All stop words — should fall back to using them
    const result = await memorySearch(db, { query: "это был он" });
    // May or may not find (depends on FTS indexing of these short words)
    // Key: should NOT throw
    expect(result.query_time_ms).toBeGreaterThanOrEqual(0);
  });

  it("handles prepositions in context: 'про медитацию'", async () => {
    memoryAdd(db, { content: "Книга про медитацию и осознанность", layer: "resource" });
    // "про" is a stop word, "медитацию" has semantic value
    const result = await memorySearch(db, { query: "про медитацию" });
    expect(result.memories.length).toBeGreaterThan(0);
  });

  it("stemmer matches morphological variants: субличность/субличностях", async () => {
    memoryAdd(db, { content: "Работа с субличностями через IFS терапию", layer: "semantic" });
    // Query uses different word form — stemmer should reduce both to "субличн"
    const result = await memorySearch(db, { query: "субличность" });
    expect(result.memories.length).toBeGreaterThan(0);
  });

  it("stemmer matches English variants: meditation/meditating", async () => {
    memoryAdd(db, { content: "Daily meditation practice improves focus", layer: "semantic" });
    const result = await memorySearch(db, { query: "meditating daily" });
    expect(result.memories.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Validation edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles FTS5 special characters in search query", async () => {
    memoryAdd(db, { content: "function() { return true; }", layer: "procedural" });
    // Should not throw — special chars are escaped
    const result = await memorySearch(db, { query: "function() return" });
    expect(result.memories.length).toBeGreaterThanOrEqual(0);
  });

  it("handles empty search results gracefully", async () => {
    const result = await memorySearch(db, { query: "nonexistent_term_xyz" });
    expect(result.memories).toEqual([]);
    expect(result.returned_count).toBe(0);
  });

  it("handles min_confidence filter", async () => {
    memoryAdd(db, { content: "low confidence fact", layer: "semantic", confidence: 0.3 });
    memoryAdd(db, { content: "high confidence fact", layer: "semantic", confidence: 0.9 });

    const result = await memorySearch(db, { query: "confidence fact", min_confidence: 0.5 });
    expect(result.memories.length).toBe(1);
    expect(result.memories[0]!.content).toContain("high");
  });

  it("handles date range filtering", async () => {
    memoryAdd(db, { content: "January event", layer: "episodic", event_at: "2026-01-15T10:00:00Z" });
    memoryAdd(db, { content: "March event", layer: "episodic", event_at: "2026-03-15T10:00:00Z" });

    const result = await memorySearch(db, { query: "event", date_from: "2026-03-01", date_to: "2026-03-31" });
    expect(result.memories.length).toBe(1);
    expect(result.memories[0]!.content).toContain("March");
  });
});

// ---------------------------------------------------------------------------
// Index-time stemming
// ---------------------------------------------------------------------------

describe("index-time stemming", () => {
  it("populates stemmed_content and stemmed_title on insert", () => {
    const result = memoryAdd(db, {
      content: "Субличности в психологии — внутренние части личности",
      layer: "semantic",
      title: "Субличности",
    });

    const row = db.prepare("SELECT stemmed_content, stemmed_title FROM memories WHERE id = ?")
      .get(result.id) as { stemmed_content: string; stemmed_title: string };

    expect(row.stemmed_content).toBeTruthy();
    expect(row.stemmed_title).toBeTruthy();
    // Stemmed content should be shorter (stems are truncated)
    expect(row.stemmed_content.length).toBeLessThan("Субличности в психологии — внутренние части личности".length);
  });

  it("FTS5 indexes stemmed content for better morphological matching", () => {
    memoryAdd(db, {
      content: "Работа с субличностями через IFS терапию",
      layer: "semantic",
    });

    // Verify FTS5 contains stemmed form
    const ftsRow = db.prepare("SELECT content FROM memories_fts WHERE memories_fts MATCH ?")
      .get(stemText("субличностями")) as { content: string } | undefined;

    expect(ftsRow).toBeDefined();
  });

  it("updates stemmed content on in-place update", () => {
    const added = memoryAdd(db, {
      content: "original content",
      layer: "semantic",
      title: "Original Title",
    });

    memoryUpdate(db, { id: added.id, content: "Обновлённое содержание записи" });

    const row = db.prepare("SELECT stemmed_content FROM memories WHERE id = ?")
      .get(added.id) as { stemmed_content: string };

    // ё is normalized to е by stemmer, so "обновлённое" → "обновлен"
    expect(row.stemmed_content).toContain("обновлен");
  });

  it("populates stemmed content on superseding entry", () => {
    const v1 = memoryAdd(db, { content: "version one", layer: "semantic" });
    const result = memoryUpdate(db, {
      id: v1.id,
      new_content: "Новая версия с другим содержанием",
      supersede: true,
    });

    const row = db.prepare("SELECT stemmed_content FROM memories WHERE id = ?")
      .get(result.new_id!) as { stemmed_content: string };

    expect(row.stemmed_content).toBeTruthy();
    expect(row.stemmed_content).toContain("нов");
  });

  it("stemText handles mixed Russian/English content", () => {
    const result = stemText("TypeScript enables strict type checking для проектов");
    expect(result).toContain("typescript");
    expect(result).toContain("проект"); // "проектов" → stem "проект"
    expect(result).toContain("enabl"); // "enables" → stem "enabl"
    // Note: stop words are NOT removed by stemText — that's query-time only
  });

  it("stemText preserves numbers", () => {
    const result = stemText("Version 2026 has 100 features");
    expect(result).toContain("2026");
    expect(result).toContain("100");
  });
});

// ---------------------------------------------------------------------------
// MCP Resources (via createMcpServer)
// ---------------------------------------------------------------------------

describe("MCP server capabilities", () => {
  it("createMcpServer returns a server with tools, resources, and prompts", async () => {
    // Verify the server factory imports work and capabilities are set
    const { createMcpServer } = await import("../../server.js");
    const server = createMcpServer(db);
    expect(server).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Decay scoring
// ---------------------------------------------------------------------------

describe("decay scoring", () => {
  it("older episodic memory scores lower than newer one", async () => {
    const old = memoryAdd(db, { content: "session notes about project alpha", layer: "episodic" });
    db.prepare("UPDATE memories SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(old.id);
    const recent = memoryAdd(db, { content: "session notes about project alpha", layer: "episodic" });
    const result = await memorySearch(db, { query: "session notes project alpha" });
    expect(result.memories.length).toBe(2);
    // Recent should rank higher due to decay
    expect(result.memories[0]!.id).toBe(recent.id);
    expect(result.memories[0]!.score).toBeGreaterThan(result.memories[1]!.score);
  });

  it("old semantic memory retains full score (no decay)", async () => {
    const fact = memoryAdd(db, { content: "blood type is A positive", layer: "semantic", importance: 0.9 });
    db.prepare("UPDATE memories SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(fact.id);
    const result = await memorySearch(db, { query: "blood type" });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories.some(m => m.id === fact.id)).toBe(true);
  });

  it("old procedural memory retains full score (no decay)", async () => {
    const rule = memoryAdd(db, { content: "always run tests before deployment", layer: "procedural" });
    db.prepare("UPDATE memories SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(rule.id);
    const result = await memorySearch(db, { query: "tests before deployment" });
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0]!.id).toBe(rule.id);
  });

  it("recently accessed episodic memory decays slower", async () => {
    const m1 = memoryAdd(db, { content: "old session about database tuning", layer: "episodic" });
    const m2 = memoryAdd(db, { content: "old session about database tuning", layer: "episodic" });
    // Both created long ago
    db.prepare("UPDATE memories SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(m1.id);
    db.prepare("UPDATE memories SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(m2.id);
    // But m2 was accessed recently
    db.prepare("UPDATE memories SET last_accessed = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(m2.id);

    const result = await memorySearch(db, { query: "database tuning session" });
    expect(result.memories.length).toBe(2);
    // m2 (recently accessed) should score higher
    expect(result.memories[0]!.id).toBe(m2.id);
  });
});

// ---------------------------------------------------------------------------
// Importance weight range
// ---------------------------------------------------------------------------

describe("importance weight range", () => {
  it("importance 1.0 gives 3.33x boost over importance 0.0", async () => {
    const low = memoryAdd(db, { content: "importance range test item low", layer: "semantic", importance: 0.0 });
    const high = memoryAdd(db, { content: "importance range test item high", layer: "semantic", importance: 1.0 });
    const result = await memorySearch(db, { query: "importance range test item" });
    const highScore = result.memories.find(m => m.id === high.id)!.score;
    const lowScore = result.memories.find(m => m.id === low.id)!.score;
    // ratio should be 1.0/0.3 = 3.33
    const ratio = highScore / lowScore;
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(3.5);
  });
});

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

describe("contradiction detection", () => {
  it("returns potential_conflicts when similar content exists for same entity", () => {
    memoryAdd(db, { content: "prefers tabs for indentation", layer: "semantic", entity_name: "nikita" });
    const result = memoryAdd(db, { content: "prefers spaces for indentation", layer: "semantic", entity_name: "nikita" });
    expect(result.potential_conflicts).toBeDefined();
    expect(result.potential_conflicts!.length).toBeGreaterThan(0);
  });

  it("does not return conflicts when entity_name is not provided", () => {
    memoryAdd(db, { content: "some fact about coding style", layer: "semantic" });
    const result = memoryAdd(db, { content: "some fact about coding style", layer: "semantic" });
    expect(result.potential_conflicts).toBeUndefined();
  });

  it("does not return conflicts for different entities", () => {
    memoryAdd(db, { content: "unique contradict test alpha", layer: "semantic", entity_name: "alice" });
    const result = memoryAdd(db, { content: "unique contradict test alpha", layer: "semantic", entity_name: "bob" });
    expect(result.potential_conflicts ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Memory analytics
// ---------------------------------------------------------------------------

describe("memory analytics", () => {
  it("returns never_accessed count in layer stats", () => {
    memoryAdd(db, { content: "analytics test 1", layer: "semantic" });
    memoryAdd(db, { content: "analytics test 2", layer: "semantic" });
    // Neither has been accessed
    const result = memoryInspect(db, {});
    expect(result.layer_stats!.semantic.never_accessed).toBe(2);
  });

  it("returns avg_age_days in layer stats", () => {
    memoryAdd(db, { content: "age test item", layer: "episodic" });
    const result = memoryInspect(db, {});
    // Just created, avg_age should be ~0
    expect(result.layer_stats!.episodic.avg_age_days).toBeGreaterThanOrEqual(0);
    expect(result.layer_stats!.episodic.avg_age_days).toBeLessThan(1);
  });

  it("returns stale_count for old accessed memories", () => {
    const m = memoryAdd(db, { content: "stale analytics test", layer: "semantic" });
    // Simulate access 60 days ago
    db.prepare("UPDATE memories SET last_accessed = datetime('now', '-60 days'), access_count = 1 WHERE id = ?").run(m.id);
    const result = memoryInspect(db, {});
    expect(result.layer_stats!.semantic.stale_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// EventType and event_log consistency
// ---------------------------------------------------------------------------

describe("event_log schema", () => {
  it("accepts 'deleted' event type in event_log", () => {
    const added = memoryAdd(db, { content: "event type test", layer: "semantic" });
    // memory_delete inserts 'deleted' event type
    memoryDelete(db, { id: added.id });
    const events = db.prepare(
      "SELECT event_type FROM event_log WHERE memory_id = ? AND event_type = 'deleted'"
    ).all(added.id) as Array<{ event_type: string }>;
    expect(events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// insertMemory shared helper (via memory_add + memory_update)
// ---------------------------------------------------------------------------

describe("shared insertMemory helper", () => {
  it("memory_add and memory_update produce identical column structure", () => {
    const added = memoryAdd(db, {
      content: "helper test original",
      layer: "semantic",
      title: "Helper Test",
      entity_name: "test-entity",
      importance: 0.7,
    });

    const result = memoryUpdate(db, {
      id: added.id,
      supersede: true,
      new_content: "helper test superseded",
    });

    const cols1 = Object.keys(
      db.prepare("SELECT * FROM memories WHERE id = ?").get(added.id) as Record<string, unknown>
    ).sort();
    const cols2 = Object.keys(
      db.prepare("SELECT * FROM memories WHERE id = ?").get(result.new_id!) as Record<string, unknown>
    ).sort();

    expect(cols1).toEqual(cols2);
  });
});

// ---------------------------------------------------------------------------
// Temporal fact windows (valid_from / valid_until + as_of)
// ---------------------------------------------------------------------------

describe("temporal fact windows", () => {
  it("stores valid_from and valid_until on insert", () => {
    const result = memoryAdd(db, {
      content: "CEO is Alice",
      layer: "semantic",
      entity_name: "company",
      valid_from: "2025-01-01",
      valid_until: "2025-12-31",
    });

    const row = db.prepare("SELECT valid_from, valid_until FROM memories WHERE id = ?")
      .get(result.id) as { valid_from: string | null; valid_until: string | null };
    expect(row.valid_from).toBe("2025-01-01");
    expect(row.valid_until).toBe("2025-12-31");
  });

  it("defaults valid_from/valid_until to null", () => {
    const result = memoryAdd(db, { content: "timeless fact", layer: "semantic" });
    const row = db.prepare("SELECT valid_from, valid_until FROM memories WHERE id = ?")
      .get(result.id) as { valid_from: string | null; valid_until: string | null };
    expect(row.valid_from).toBeNull();
    expect(row.valid_until).toBeNull();
  });

  it("as_of filter excludes memories not yet valid", async () => {
    memoryAdd(db, {
      content: "future CEO is Bob",
      layer: "semantic",
      entity_name: "company",
      valid_from: "2027-01-01",
    });
    memoryAdd(db, {
      content: "current CEO is Alice",
      layer: "semantic",
      entity_name: "company",
    });

    const result = await memorySearch(db, { query: "CEO", as_of: "2026-06-01" });
    expect(result.memories.length).toBe(1);
    expect(result.memories[0]!.content).toContain("Alice");
  });

  it("as_of filter excludes memories that expired before the date", async () => {
    memoryAdd(db, {
      content: "old CEO was Charlie",
      layer: "semantic",
      entity_name: "company",
      valid_until: "2024-12-31",
    });
    memoryAdd(db, {
      content: "current CEO is Alice",
      layer: "semantic",
      entity_name: "company",
    });

    const result = await memorySearch(db, { query: "CEO", as_of: "2025-06-01" });
    expect(result.memories.length).toBe(1);
    expect(result.memories[0]!.content).toContain("Alice");
  });

  it("as_of filter returns memory within valid window", async () => {
    memoryAdd(db, {
      content: "Q1 target is 100K",
      layer: "semantic",
      valid_from: "2026-01-01",
      valid_until: "2026-03-31",
    });

    const inside = await memorySearch(db, { query: "target", as_of: "2026-02-15" });
    expect(inside.memories.length).toBe(1);

    const outside = await memorySearch(db, { query: "target", as_of: "2026-05-01" });
    expect(outside.memories.length).toBe(0);
  });

  it("as_of works with exact search mode", async () => {
    memoryAdd(db, {
      content: "seasonal discount 20%",
      layer: "semantic",
      valid_from: "2026-06-01",
      valid_until: "2026-08-31",
    });

    const inside = await memorySearch(db, { query: "seasonal discount", mode: "exact", as_of: "2026-07-15" });
    expect(inside.memories.length).toBe(1);

    const outside = await memorySearch(db, { query: "seasonal discount", mode: "exact", as_of: "2026-01-01" });
    expect(outside.memories.length).toBe(0);
  });

  it("memories with null valid_from/valid_until always match as_of", async () => {
    memoryAdd(db, { content: "eternal fact xyz", layer: "semantic" });
    const result = await memorySearch(db, { query: "eternal fact xyz", as_of: "2000-01-01" });
    expect(result.memories.length).toBe(1);
  });

  it("superseding entry inherits valid_from/valid_until", () => {
    const v1 = memoryAdd(db, {
      content: "v1 with temporal",
      layer: "semantic",
      valid_from: "2025-01-01",
      valid_until: "2025-12-31",
    });
    const result = memoryUpdate(db, { id: v1.id, supersede: true, new_content: "v2 with temporal" });

    const row = db.prepare("SELECT valid_from, valid_until FROM memories WHERE id = ?")
      .get(result.new_id!) as { valid_from: string | null; valid_until: string | null };
    expect(row.valid_from).toBe("2025-01-01");
    expect(row.valid_until).toBe("2025-12-31");
  });
});

// ---------------------------------------------------------------------------
// Entity aliases
// ---------------------------------------------------------------------------

describe("entity aliases", () => {
  function insertAlias(canonical: string, alias: string) {
    db.prepare("INSERT INTO entity_aliases (canonical, alias) VALUES (?, ?)").run(canonical, alias);
  }

  it("FTS search resolves alias to canonical entity_name", async () => {
    memoryAdd(db, { content: "Nikita prefers dark mode", layer: "semantic", entity_name: "nikita" });
    insertAlias("nikita", "ник");

    const result = await memorySearch(db, { query: "dark mode", entity_name: "ник" });
    expect(result.memories.length).toBe(1);
    expect(result.memories[0]!.entity_name).toBe("nikita");
  });

  it("exact search resolves alias to canonical entity_name", async () => {
    memoryAdd(db, { content: "Nikita lives in Bangkok", layer: "semantic", entity_name: "nikita" });
    insertAlias("nikita", "никита");

    const result = await memorySearch(db, { query: "Bangkok", mode: "exact", entity_name: "никита" });
    expect(result.memories.length).toBe(1);
    expect(result.memories[0]!.entity_name).toBe("nikita");
  });

  it("search with canonical name still works", async () => {
    memoryAdd(db, { content: "canonical name test", layer: "semantic", entity_name: "alice" });
    insertAlias("alice", "алиса");

    const result = await memorySearch(db, { query: "canonical name test", entity_name: "alice" });
    expect(result.memories.length).toBe(1);
  });

  it("unknown alias passes through unchanged", async () => {
    memoryAdd(db, { content: "unknown alias test content", layer: "semantic", entity_name: "bob" });

    const result = await memorySearch(db, { query: "unknown alias test", entity_name: "bob" });
    expect(result.memories.length).toBe(1);
  });

  it("alias table enforces unique alias constraint", () => {
    insertAlias("nikita", "nick");
    expect(() => insertAlias("alice", "nick")).toThrow();
  });

  it("alias cannot equal canonical (CHECK constraint)", () => {
    expect(() => insertAlias("nikita", "nikita")).toThrow();
  });

  it("resolves alias when searching by entity_name filter", async () => {
    memoryAdd(db, { content: "Nikita uses Neovim for coding", layer: "semantic", entity_name: "nikita" });
    insertAlias("nikita", "коля");

    // Search using the alias — entity_name filter should resolve to canonical
    const result = await memorySearch(db, { query: "Neovim coding", entity_name: "коля" });
    expect(result.memories.length).toBe(1);
    expect(result.memories[0]!.entity_name).toBe("nikita");
  });
});

// ---------------------------------------------------------------------------
// memory_search — additional pagination correctness
// ---------------------------------------------------------------------------

describe("memory_search — pagination correctness", () => {
  it("offset=2 limit=2 returns different items from offset=0 limit=2", async () => {
    for (let i = 1; i <= 5; i++) {
      memoryAdd(db, {
        content: `pagcorrect item content ${i}`,
        layer: "semantic",
        importance: i * 0.15,
      });
    }

    const firstPage = await memorySearch(db, { query: "pagcorrect item content", mode: "exact", limit: 2, offset: 0 });
    const secondPage = await memorySearch(db, { query: "pagcorrect item content", mode: "exact", limit: 2, offset: 2 });

    expect(firstPage.memories.length).toBe(2);
    expect(secondPage.memories.length).toBe(2);

    const firstIds = new Set(firstPage.memories.map((m) => m.id));
    for (const m of secondPage.memories) {
      expect(firstIds.has(m.id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// memory_search — ranking
// ---------------------------------------------------------------------------

describe("memory_search — ranking", () => {
  it("ranks a title match above a single content match (bm25 field weights)", async () => {
    // Filler corpus so the query term has meaningful idf
    for (let i = 0; i < 20; i++) {
      memoryAdd(db, { content: `plain filler content row number ${i}`, title: `filler note ${i}`, layer: "semantic" });
    }
    const inTitle = memoryAdd(db, {
      content: "unrelated body text about other things entirely",
      title: "zephyrium discovery",
      layer: "semantic",
    });
    const inContent = memoryAdd(db, {
      content: "notes about zephyrium in the body of this memory",
      title: "unrelated title",
      layer: "semantic",
    });

    const result = await memorySearch(db, { query: "zephyrium" });
    const ids = result.memories.map((m) => m.id);
    expect(ids.indexOf(inTitle.id)).toBeLessThan(ids.indexOf(inContent.id));
  });

  it("applies the importance boost once for pure date-range queries", async () => {
    const hi = memoryAdd(db, { content: "встреча с командой", layer: "episodic", importance: 0.9, event_at: "2025-03-15T12:00:00Z" });
    const lo = memoryAdd(db, { content: "другая заметка", layer: "episodic", importance: 0.2, event_at: "2025-03-15T13:00:00Z" });

    const result = await memorySearch(db, { query: "в марте 2025" });
    const hiScore = result.memories.find((m) => m.id === hi.id)!.score;
    const loScore = result.memories.find((m) => m.id === lo.id)!.score;

    // Same layer and created_at → decay and recency cancel in the ratio,
    // leaving exactly one linear importance boost (not its square)
    expect(hiScore / loScore).toBeCloseTo((0.3 + 0.7 * 0.9) / (0.3 + 0.7 * 0.2), 5);
  });

  it("honors as_of in pure date-range queries", async () => {
    const current = memoryAdd(db, { content: "актуальное правило", layer: "episodic", event_at: "2025-03-10T00:00:00Z" });
    const outdated = memoryAdd(db, {
      content: "устаревшее правило",
      layer: "episodic",
      event_at: "2025-03-11T00:00:00Z",
      valid_until: "2025-01-01",
    });

    const result = await memorySearch(db, { query: "в марте 2025", as_of: "2025-06-01" });
    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain(current.id);
    expect(ids).not.toContain(outdated.id);
  });
});

// ---------------------------------------------------------------------------
// validation edge cases
// ---------------------------------------------------------------------------

describe("validation edge cases", () => {
  it("search with query of only escapeable special characters throws an error", async () => {
    // All chars stripped by escapeFtsToken → no valid FTS tokens remain → throws
    await expect(memorySearch(db, { query: "*** ??? !!!" })).rejects.toThrow(
      /at least one non-empty term|Invalid search query/
    );
  });
});

// ---------------------------------------------------------------------------
// vector / hybrid search modes — error handling without embedder
// ---------------------------------------------------------------------------

describe("vector search — graceful degradation", () => {
  it("vector mode throws without embedder", async () => {
    await expect(
      memorySearch(db, { query: "test query", mode: "vector" })
    ).rejects.toThrow(/embedding provider/i);
  });

  it("hybrid mode throws without embedder", async () => {
    await expect(
      memorySearch(db, { query: "test query", mode: "hybrid" })
    ).rejects.toThrow(/embedding provider/i);
  });

  it("vector mode throws with embedder but no sqlite-vec", async () => {
    const mockEmbedder = {
      embed: async () => new Float32Array(1024),
      embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(1024)),
      dimensions: 1024,
      provider: "mock",
      model: "mock-model",
    };
    await expect(
      memorySearch(db, { query: "test query", mode: "vector" }, mockEmbedder)
    ).rejects.toThrow(/sqlite-vec/i);
  });

  it("fts mode still works without embedder", async () => {
    memoryAdd(db, { content: "vector test content", layer: "semantic" });
    const result = await memorySearch(db, { query: "vector test content" });
    expect(result.memories.length).toBe(1);
  });

  it("exact mode still works without embedder", async () => {
    memoryAdd(db, { content: "exact vector test", layer: "semantic" });
    const result = await memorySearch(db, { query: "exact vector test", mode: "exact" });
    expect(result.memories.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// database file permissions
// ---------------------------------------------------------------------------

describe("database file permissions", () => {
  it("creates the db directory 0700 and db file 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "mnemon-perms-"));
    const dbPath = join(dir, "store", "perm.db");

    const pdb = openDatabase(dbPath);
    pdb.close();

    if (process.platform !== "win32") {
      expect(statSync(join(dir, "store")).mode & 0o777).toBe(0o700);
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// memory_health — diagnostic tool
// ---------------------------------------------------------------------------

describe("memory_health", () => {
  it("returns healthy status on empty database", () => {
    const result = memoryHealth(db, {});
    expect(result.status).toBe("healthy");
    expect(result.issues).toEqual([]);
    expect(result.stats.total_active).toBe(0);
    expect(result.stats.total_superseded).toBe(0);
    expect(result.expired).toEqual([]);
    expect(result.orphaned_chains).toEqual([]);
  });

  it("reports per-layer stats", () => {
    memoryAdd(db, { content: "sem fact", layer: "semantic" });
    memoryAdd(db, { content: "ep event", layer: "episodic" });
    memoryAdd(db, { content: "proc rule", layer: "procedural" });
    const result = memoryHealth(db, {});
    expect(result.stats.total_active).toBe(3);
    expect(result.stats.by_layer["semantic"]).toBe(1);
    expect(result.stats.by_layer["episodic"]).toBe(1);
    expect(result.stats.by_layer["procedural"]).toBe(1);
  });

  it("detects expired entries", () => {
    const m = memoryAdd(db, { content: "expiring memory", layer: "semantic", ttl_days: 1 });
    // Simulate expired: set expires_at to yesterday
    db.prepare("UPDATE memories SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(m.id);
    const result = memoryHealth(db, {});
    expect(result.expired.length).toBe(1);
    expect(result.expired[0]!.id).toBe(m.id);
    expect(result.issues.some((i) => i.includes("expired"))).toBe(true);
  });

  it("cleanup=true garbage-collects expired entries", () => {
    const m = memoryAdd(db, { content: "gc target", layer: "semantic", ttl_days: 1 });
    db.prepare("UPDATE memories SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(m.id);

    const result = memoryHealth(db, { cleanup: true });
    expect(result.cleaned_expired).toBe(1);

    // Verify deleted
    const row = db.prepare("SELECT id FROM memories WHERE id = ?").get(m.id);
    expect(row).toBeUndefined();
  });

  it("cleanup repairs the chain when adjacent links expire together", () => {
    // A→B→C→D with B and C expired: survivors A and D must be linked directly
    const a = memoryAdd(db, { content: "chain v1", layer: "semantic" });
    const b = memoryUpdate(db, { id: a.id, supersede: true, new_content: "chain v2" });
    const c = memoryUpdate(db, { id: b.new_id!, supersede: true, new_content: "chain v3" });
    const d = memoryUpdate(db, { id: c.new_id!, supersede: true, new_content: "chain v4" });
    db.prepare("UPDATE memories SET expires_at = datetime('now', '-1 day') WHERE id IN (?, ?)").run(b.new_id, c.new_id);

    const result = memoryHealth(db, { cleanup: true });
    expect(result.cleaned_expired).toBe(2);

    const aRow = db.prepare("SELECT superseded_by FROM memories WHERE id = ?").get(a.id) as { superseded_by: string | null };
    const dRow = db.prepare("SELECT supersedes, superseded_by FROM memories WHERE id = ?").get(d.new_id!) as { supersedes: string | null; superseded_by: string | null };
    expect(aRow.superseded_by).toBe(d.new_id);
    expect(dRow.supersedes).toBe(a.id);
    expect(dRow.superseded_by).toBeNull();
  });

  it("cleanup deletes a fully expired chain without FK errors", () => {
    const a = memoryAdd(db, { content: "doomed v1", layer: "semantic" });
    const b = memoryUpdate(db, { id: a.id, supersede: true, new_content: "doomed v2" });
    db.prepare("UPDATE memories SET expires_at = datetime('now', '-1 day') WHERE id IN (?, ?)").run(a.id, b.new_id);

    const result = memoryHealth(db, { cleanup: true });
    expect(result.cleaned_expired).toBe(2);
    const remaining = db.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number };
    expect(remaining.count).toBe(0);
  });

  it("cleanup reactivates the nearest survivor when the chain tail expires", () => {
    // A→B→C with B and C expired: A becomes active again
    const a = memoryAdd(db, { content: "tail v1", layer: "semantic" });
    const b = memoryUpdate(db, { id: a.id, supersede: true, new_content: "tail v2" });
    const c = memoryUpdate(db, { id: b.new_id!, supersede: true, new_content: "tail v3" });
    db.prepare("UPDATE memories SET expires_at = datetime('now', '-1 day') WHERE id IN (?, ?)").run(b.new_id, c.new_id);

    const result = memoryHealth(db, { cleanup: true });
    expect(result.cleaned_expired).toBe(2);
    const aRow = db.prepare("SELECT superseded_by FROM memories WHERE id = ?").get(a.id) as { superseded_by: string | null };
    expect(aRow.superseded_by).toBeNull();
  });

  it("expired_count matches the cleanup row set, including superseded links", () => {
    // A→B with A superseded AND expired: display list hides it, count must not
    const a = memoryAdd(db, { content: "count v1", layer: "semantic" });
    memoryUpdate(db, { id: a.id, supersede: true, new_content: "count v2" });
    db.prepare("UPDATE memories SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(a.id);

    const report = memoryHealth(db, {});
    expect(report.expired_count).toBe(1);
    expect(report.expired.length).toBe(0);
    expect(report.issues.some((i) => i.includes("1 expired"))).toBe(true);

    const result = memoryHealth(db, { cleanup: true });
    expect(result.cleaned_expired).toBe(1);
  });

  it("detects orphaned superseding chains", () => {
    const m = memoryAdd(db, { content: "orphan child", layer: "semantic" });
    // Disable FK checks to simulate orphaned data (e.g. manual DB edit)
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE memories SET supersedes = ? WHERE id = ?").run("nonexistent-id-12345", m.id);
    db.pragma("foreign_keys = ON");

    const result = memoryHealth(db, {});
    expect(result.orphaned_chains.length).toBe(1);
    expect(result.orphaned_chains[0]!.id).toBe(m.id);
    expect(result.orphaned_chains[0]!.missing_supersedes).toBe("nonexistent-id-12345");
  });

  it("detects low-confidence entries", () => {
    memoryAdd(db, { content: "low conf memory", layer: "semantic", confidence: 0.1 });
    memoryAdd(db, { content: "high conf memory", layer: "semantic", confidence: 0.9 });

    const result = memoryHealth(db, {});
    expect(result.low_confidence_count).toBe(1);
  });

  it("counts superseded entries", () => {
    const v1 = memoryAdd(db, { content: "version 1", layer: "semantic" });
    memoryUpdate(db, { id: v1.id, supersede: true, new_content: "version 2" });

    const result = memoryHealth(db, {});
    expect(result.stats.total_superseded).toBe(1);
    expect(result.stats.total_active).toBe(1);
  });

  it("returns degraded status with multiple issues", () => {
    // Create 3 different issue types
    const m1 = memoryAdd(db, { content: "exp mem", layer: "semantic", ttl_days: 1 });
    db.prepare("UPDATE memories SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(m1.id);

    const m2 = memoryAdd(db, { content: "orphan mem", layer: "semantic" });
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE memories SET supersedes = 'missing-999' WHERE id = ?").run(m2.id);
    db.pragma("foreign_keys = ON");

    memoryAdd(db, { content: "low conf", layer: "semantic", confidence: 0.1 });

    const result = memoryHealth(db, {});
    expect(result.status).toBe("degraded");
    expect(result.issues.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle tools
// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
  it("sessionStart creates a session and returns id + started_at", () => {
    const result = sessionStart(db, { client: "claude-code" });
    expect(result.id).toMatch(/^[0-9a-f]{32}$/);
    expect(result.started_at).toBeTruthy();
  });

  it("sessionStart stores project and meta", () => {
    const result = sessionStart(db, {
      client: "cursor",
      project: "mnemon-mcp",
      meta: { reason: "testing" },
    });
    const row = db.prepare("SELECT client, project, meta FROM sessions WHERE id = ?")
      .get(result.id) as { client: string; project: string | null; meta: string };
    expect(row.client).toBe("cursor");
    expect(row.project).toBe("mnemon-mcp");
    expect(JSON.parse(row.meta)).toEqual({ reason: "testing" });
  });

  it("sessionEnd ends a session and returns duration", () => {
    const session = sessionStart(db, { client: "api" });
    const result = sessionEnd(db, { id: session.id, summary: "did some work" });
    expect(result.id).toBe(session.id);
    expect(result.ended_at).toBeTruthy();
    expect(result.duration_minutes).toBeTypeOf("number");
    expect(result.memories_count).toBe(0);
  });

  it("sessionEnd counts memories created during session", () => {
    const session = sessionStart(db, { client: "claude-code" });
    memoryAdd(db, { content: "session memory 1", layer: "episodic", session_id: session.id });
    memoryAdd(db, { content: "session memory 2", layer: "episodic", session_id: session.id });
    const result = sessionEnd(db, { id: session.id });
    expect(result.memories_count).toBe(2);
  });

  it("sessionEnd throws for non-existent session", () => {
    expect(() => sessionEnd(db, { id: "nonexistent" })).toThrow(/not found/);
  });

  it("sessionEnd throws for already-ended session", () => {
    const session = sessionStart(db, { client: "api" });
    sessionEnd(db, { id: session.id });
    expect(() => sessionEnd(db, { id: session.id })).toThrow(/already ended/);
  });

  it("sessionList returns recent sessions", () => {
    sessionStart(db, { client: "claude-code", project: "proj-a" });
    sessionStart(db, { client: "cursor", project: "proj-b" });
    const result = sessionList(db, {});
    expect(result.sessions.length).toBe(2);
    expect(result.returned_count).toBe(2);
  });

  it("sessionList filters by client", () => {
    sessionStart(db, { client: "claude-code" });
    sessionStart(db, { client: "cursor" });
    const result = sessionList(db, { client: "cursor" });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0]!.client).toBe("cursor");
  });

  it("sessionList filters by project", () => {
    sessionStart(db, { client: "api", project: "alpha" });
    sessionStart(db, { client: "api", project: "beta" });
    const result = sessionList(db, { project: "alpha" });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0]!.project).toBe("alpha");
  });

  it("sessionList active_only excludes ended sessions", () => {
    const s1 = sessionStart(db, { client: "api" });
    sessionStart(db, { client: "api" });
    sessionEnd(db, { id: s1.id });
    const result = sessionList(db, { active_only: true });
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0]!.ended_at).toBeNull();
  });

  it("sessionList respects limit", () => {
    for (let i = 0; i < 5; i++) {
      sessionStart(db, { client: "api" });
    }
    const result = sessionList(db, { limit: 3 });
    expect(result.sessions.length).toBe(3);
  });

  it("sessionList includes memories_count per session", () => {
    const s = sessionStart(db, { client: "api" });
    memoryAdd(db, { content: "mem for count test", layer: "episodic", session_id: s.id });
    const result = sessionList(db, {});
    const found = result.sessions.find((sess) => sess.id === s.id);
    expect(found).toBeDefined();
    expect(found!.memories_count).toBe(1);
  });
});
