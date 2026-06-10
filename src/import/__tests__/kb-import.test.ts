/**
 * Integration tests for the KB import pipeline.
 * Uses fixture files in a temp directory and an in-memory SQLite DB.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { openDatabase } from "../../db.js";
import { processFile } from "../kb-import.js";
import type { FileMapping } from "../kb-config.js";

let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  tmpDir = join(tmpdir(), `mnemon-import-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(relativePath: string, content: string): string {
  const fullPath = join(tmpDir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

const semanticMapping: FileMapping = {
  layer: "semantic",
  entity_type: "concept",
  importance: 0.6,
  confidence: 0.8,
  split: "h2",
};

const wholeMapping: FileMapping = {
  layer: "resource",
  entity_type: "concept",
  importance: 0.5,
  confidence: 0.8,
  split: "whole",
};

const personMapping: FileMapping = {
  layer: "semantic",
  entity_type: "person",
  entity_name: "from-heading",
  importance: 0.8,
  confidence: 0.8,
  split: "h3",
};

// ---------------------------------------------------------------------------
// processFile — basic import
// ---------------------------------------------------------------------------

describe("processFile — basic import", () => {
  it("imports whole file as single memory", () => {
    const path = writeFixture("notes/simple.md", "This is a simple note about testing.");
    const result = processFile(db, path, wholeMapping, tmpDir, false, false);

    expect(result.status).toBe("imported");
    expect(result.created).toBe(1);

    const rows = db.prepare("SELECT content, layer FROM memories").all() as Array<{ content: string; layer: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.layer).toBe("resource");
    expect(rows[0]!.content).toContain("simple note about testing");
  });

  it("splits file by h2 headings", () => {
    const content = `## TypeScript
TypeScript is great for type safety.

## SQLite
SQLite is a file-based database.

## Vitest
Vitest is fast for testing.`;

    const path = writeFixture("knowledge/tech.md", content);
    const result = processFile(db, path, semanticMapping, tmpDir, false, false);

    expect(result.status).toBe("imported");
    expect(result.created).toBe(3);

    const rows = db.prepare("SELECT title, layer FROM memories ORDER BY title").all() as Array<{ title: string; layer: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.title)).toEqual(["SQLite", "TypeScript", "Vitest"]);
  });

  it("splits file by h3 headings for person entities", () => {
    const content = `### Alice
Friend from school.

### Bob
Colleague at work.`;

    const path = writeFixture("people/contacts.md", content);
    const result = processFile(db, path, personMapping, tmpDir, false, false);

    expect(result.created).toBe(2);

    const rows = db.prepare("SELECT entity_name FROM memories ORDER BY entity_name").all() as Array<{ entity_name: string }>;
    expect(rows.map(r => r.entity_name)).toEqual(["Alice", "Bob"]);
  });

  it("imports file without headings as whole when split mode is h2", () => {
    const path = writeFixture("knowledge/flat.md", "No headings here, just plain text content.");
    const result = processFile(db, path, semanticMapping, tmpDir, false, false);

    expect(result.created).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// processFile — hash dedup
// ---------------------------------------------------------------------------

describe("processFile — hash dedup", () => {
  it("skips unchanged file on second import", () => {
    const path = writeFixture("notes/dedup.md", "Content that stays the same.");

    const first = processFile(db, path, wholeMapping, tmpDir, false, false);
    expect(first.status).toBe("imported");
    expect(first.created).toBe(1);

    const second = processFile(db, path, wholeMapping, tmpDir, false, false);
    expect(second.status).toBe("skipped");
    expect(second.created).toBe(0);
  });

  it("re-imports when force=true even if hash unchanged", () => {
    const path = writeFixture("notes/force.md", "Force re-import test content.");

    processFile(db, path, wholeMapping, tmpDir, false, false);
    const second = processFile(db, path, wholeMapping, tmpDir, false, false, true);

    expect(second.status).not.toBe("skipped");
    expect(second.created).toBe(1);
  });

  it("re-imports when file content changes", () => {
    const path = writeFixture("notes/changed.md", "Version 1");
    processFile(db, path, wholeMapping, tmpDir, false, false);

    writeFileSync(path, "Version 2", "utf8");
    const second = processFile(db, path, wholeMapping, tmpDir, false, false);

    expect(second.status).not.toBe("skipped");
    expect(second.created).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// processFile — frontmatter override
// ---------------------------------------------------------------------------

describe("processFile — frontmatter override", () => {
  it("frontmatter layer override takes precedence over mapping", () => {
    const content = `---
layer: episodic
---
This should be episodic despite the mapping saying semantic.`;

    const path = writeFixture("knowledge/override.md", content);
    const result = processFile(db, path, semanticMapping, tmpDir, false, false);

    expect(result.created).toBe(1);

    const row = db.prepare("SELECT layer FROM memories").get() as { layer: string };
    expect(row.layer).toBe("episodic");
  });

  it("ignores invalid frontmatter layer values", () => {
    const content = `---
layer: invalid_layer
---
This should keep the mapping layer.`;

    const path = writeFixture("knowledge/bad-layer.md", content);
    processFile(db, path, semanticMapping, tmpDir, false, false);

    const row = db.prepare("SELECT layer FROM memories").get() as { layer: string };
    expect(row.layer).toBe("semantic");
  });
});

// ---------------------------------------------------------------------------
// processFile — dry run
// ---------------------------------------------------------------------------

describe("processFile — dry run", () => {
  it("dry run does not write to DB", () => {
    const path = writeFixture("notes/dryrun.md", "Dry run content.");
    const result = processFile(db, path, wholeMapping, tmpDir, true, false);

    expect(result.created).toBe(1);
    expect(result.status).toBe("imported");

    const count = db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// processFile — error handling
// ---------------------------------------------------------------------------

describe("processFile — error handling", () => {
  it("returns error status for unreadable file", () => {
    const result = processFile(db, "/nonexistent/path/file.md", wholeMapping, tmpDir, false, false);
    expect(result.status).toBe("error");
    expect(result.error).toContain("Read error");
  });
});

// ---------------------------------------------------------------------------
// processFile — source_file and superseding
// ---------------------------------------------------------------------------

describe("processFile — superseding", () => {
  it("supersedes previous import on content change", () => {
    const path = writeFixture("notes/evolve.md", "Version 1 content");
    processFile(db, path, wholeMapping, tmpDir, false, false);

    writeFileSync(path, "Version 2 content", "utf8");
    const result = processFile(db, path, wholeMapping, tmpDir, false, false);

    expect(result.superseded).toBeGreaterThan(0);

    // Only one active memory
    const active = db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE superseded_by IS NULL").get() as { cnt: number };
    expect(active.cnt).toBe(1);

    // Active one has v2 content
    const row = db.prepare("SELECT content FROM memories WHERE superseded_by IS NULL").get() as { content: string };
    expect(row.content).toContain("Version 2");
  });
});

// ---------------------------------------------------------------------------
// processFile — entity_name extraction
// ---------------------------------------------------------------------------

describe("processFile — entity_name extraction", () => {
  it("extracts entity_name from heading when configured as from-heading", () => {
    const content = `### Алексей — друг
Information about Alexey.`;

    const path = writeFixture("people/alexey.md", content);
    processFile(db, path, personMapping, tmpDir, false, false);

    const row = db.prepare("SELECT entity_name FROM memories").get() as { entity_name: string };
    // Should extract "Алексей" (before the —)
    expect(row.entity_name).toBe("Алексей");
  });

  it("resolves from-frontmatter entity_name from entity field", () => {
    const content = `---
entity: Юля
---
## История
Information about Yulya.`;

    const path = writeFixture("people/yulya.md", content);
    const mapping = { ...personMapping, entity_name: "from-frontmatter", split: "h2" as const };
    processFile(db, path, mapping, tmpDir, false, false);

    const row = db.prepare("SELECT entity_name FROM memories").get() as { entity_name: string };
    expect(row.entity_name).toBe("Юля");
  });

  it("falls back to file stem when from-frontmatter has no entity field", () => {
    const content = `## История
Information about someone.`;

    const path = writeFixture("people/sergey.md", content);
    const mapping = { ...personMapping, entity_name: "from-frontmatter", split: "h2" as const };
    processFile(db, path, mapping, tmpDir, false, false);

    const row = db.prepare("SELECT entity_name FROM memories").get() as { entity_name: string };
    expect(row.entity_name).toBe("sergey");
  });
});
