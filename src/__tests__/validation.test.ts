/**
 * Unit tests for Zod validation schemas in src/validation.ts.
 * Uses safeParse() for rejection tests and parse() for acceptance tests.
 */

import { describe, it, expect } from "vitest";
import {
  MemoryAddSchema,
  MemorySearchSchema,
  MemoryUpdateSchema,
  MemoryExportSchema,
  MemoryDeleteSchema,
} from "../validation.js";

// ---------------------------------------------------------------------------
// MemoryAddSchema
// ---------------------------------------------------------------------------

describe("MemoryAddSchema", () => {
  it("rejects empty content (0 chars)", () => {
    const result = MemoryAddSchema.safeParse({ content: "", layer: "semantic" });
    expect(result.success).toBe(false);
  });

  it("rejects content exceeding 100,000 chars", () => {
    const result = MemoryAddSchema.safeParse({ content: "a".repeat(100_001), layer: "semantic" });
    expect(result.success).toBe(false);
  });

  it("accepts content at exactly 100,000 chars", () => {
    const result = MemoryAddSchema.parse({ content: "a".repeat(100_000), layer: "semantic" });
    expect(result.content.length).toBe(100_000);
  });

  it("rejects title exceeding 500 chars", () => {
    const result = MemoryAddSchema.safeParse({
      content: "valid content",
      layer: "semantic",
      title: "t".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid layer enum", () => {
    const result = MemoryAddSchema.safeParse({ content: "valid content", layer: "invalid" });
    expect(result.success).toBe(false);
  });

  it.each(["episodic", "semantic", "procedural", "resource"] as const)(
    "accepts valid layer: %s",
    (layer) => {
      const result = MemoryAddSchema.parse({ content: "valid content", layer });
      expect(result.layer).toBe(layer);
    }
  );

  it("rejects negative ttl_days", () => {
    const result = MemoryAddSchema.safeParse({ content: "valid", layer: "semantic", ttl_days: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects ttl_days = 0 (must be positive)", () => {
    const result = MemoryAddSchema.safeParse({ content: "valid", layer: "semantic", ttl_days: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects confidence > 1.0", () => {
    const result = MemoryAddSchema.safeParse({ content: "valid", layer: "semantic", confidence: 1.1 });
    expect(result.success).toBe(false);
  });

  it("rejects confidence < 0", () => {
    const result = MemoryAddSchema.safeParse({ content: "valid", layer: "semantic", confidence: -0.1 });
    expect(result.success).toBe(false);
  });

  it("rejects importance > 1.0", () => {
    const result = MemoryAddSchema.safeParse({ content: "valid", layer: "semantic", importance: 1.1 });
    expect(result.success).toBe(false);
  });

  it("accepts confidence = 0 (boundary)", () => {
    const result = MemoryAddSchema.parse({ content: "valid", layer: "semantic", confidence: 0 });
    expect(result.confidence).toBe(0);
  });

  it("accepts confidence = 1.0 (boundary)", () => {
    const result = MemoryAddSchema.parse({ content: "valid", layer: "semantic", confidence: 1.0 });
    expect(result.confidence).toBe(1.0);
  });

  it.each([
    ["2025-02-31", false],
    ["2025-04-31", false],
    ["2024-02-29", true],
    ["2025-02-29", false],
  ] as const)("validates calendar date %s", (event_at, expected) => {
    const result = MemoryAddSchema.safeParse({ content: "valid", layer: "episodic", event_at });
    expect(result.success).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// MemorySearchSchema
// ---------------------------------------------------------------------------

describe("MemorySearchSchema", () => {
  it("rejects limit > 100", () => {
    const result = MemorySearchSchema.safeParse({ query: "test", limit: 101 });
    expect(result.success).toBe(false);
  });

  it("accepts limit = 100", () => {
    const result = MemorySearchSchema.parse({ query: "test", limit: 100 });
    expect(result.limit).toBe(100);
  });

  it("rejects limit = 0 (must be >= 1)", () => {
    const result = MemorySearchSchema.safeParse({ query: "test", limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects offset < 0", () => {
    const result = MemorySearchSchema.safeParse({ query: "test", offset: -1 });
    expect(result.success).toBe(false);
  });

  it("accepts offset = 0", () => {
    const result = MemorySearchSchema.parse({ query: "test", offset: 0 });
    expect(result.offset).toBe(0);
  });

  it("rejects empty query", () => {
    const result = MemorySearchSchema.safeParse({ query: "" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid layer in layers array", () => {
    const result = MemorySearchSchema.safeParse({ query: "test", layers: ["invalid"] });
    expect(result.success).toBe(false);
  });

  it.each(["fts", "exact", "vector", "hybrid"] as const)("accepts valid mode: %s", (mode) => {
    const result = MemorySearchSchema.parse({ query: "test", mode });
    expect(result.mode).toBe(mode);
  });

  it("rejects invalid mode", () => {
    const result = MemorySearchSchema.safeParse({ query: "test", mode: "semantic" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MemoryUpdateSchema
// ---------------------------------------------------------------------------

describe("MemoryUpdateSchema", () => {
  it("rejects empty id", () => {
    const result = MemoryUpdateSchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects content exceeding 100,000 chars", () => {
    const result = MemoryUpdateSchema.safeParse({ id: "abc123", content: "a".repeat(100_001) });
    expect(result.success).toBe(false);
  });

  it("accepts valid id with no optional fields", () => {
    const result = MemoryUpdateSchema.parse({ id: "abc123" });
    expect(result.id).toBe("abc123");
  });

  it("accepts new_content at exactly 100,000 chars", () => {
    const result = MemoryUpdateSchema.parse({ id: "abc123", new_content: "a".repeat(100_000) });
    expect(result.new_content!.length).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// MemoryExportSchema
// ---------------------------------------------------------------------------

describe("MemoryExportSchema", () => {
  it("rejects invalid format", () => {
    const result = MemoryExportSchema.safeParse({ format: "txt" });
    expect(result.success).toBe(false);
  });

  it.each(["json", "markdown", "claude-md"] as const)(
    "accepts valid format: %s",
    (format) => {
      const result = MemoryExportSchema.parse({ format });
      expect(result.format).toBe(format);
    }
  );

  it("rejects limit > 10,000", () => {
    const result = MemoryExportSchema.safeParse({ format: "json", limit: 10_001 });
    expect(result.success).toBe(false);
  });

  it("accepts limit = 10,000 (boundary)", () => {
    const result = MemoryExportSchema.parse({ format: "json", limit: 10_000 });
    expect(result.limit).toBe(10_000);
  });

  it("rejects limit = 0 (must be >= 1)", () => {
    const result = MemoryExportSchema.safeParse({ format: "json", limit: 0 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MemoryDeleteSchema
// ---------------------------------------------------------------------------

describe("MemoryDeleteSchema", () => {
  it("rejects empty id", () => {
    const result = MemoryDeleteSchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });

  it("accepts valid id", () => {
    const result = MemoryDeleteSchema.parse({ id: "abc123def456" });
    expect(result.id).toBe("abc123def456");
  });
});
