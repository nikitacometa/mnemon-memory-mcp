/**
 * Runtime input validation for MCP tool args.
 * Uses Zod for validation AND JSON Schema generation (single source of truth).
 *
 * Tool input schemas are generated via z.toJSONSchema() — no manual JSON Schema
 * objects in tool files. Descriptions on Zod fields become tool parameter docs.
 */

import { z } from "zod";

const Layer = z.enum(["episodic", "semantic", "procedural", "resource"]);
const EntityType = z.enum(["user", "project", "person", "concept", "file", "rule", "tool"]);
const SearchMode = z.enum(["fts", "exact", "vector", "hybrid"]);
const ExportFormat = z.enum(["json", "markdown", "claude-md"]);

// Explicit day-in-month check: Date.UTC would misvalidate years 0000-0099
// (legacy two-digit-year offset) and silently normalize overflow days
function hasValidCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

const isoDatePrefix = z.string().regex(
  /^\d{4}-\d{2}-\d{2}/,
  "Must be an ISO 8601 date (YYYY-MM-DD...)"
).refine(
  (v) => hasValidCalendarDate(v)
    && !Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)),
  "Must be a valid date"
);

export const MemoryAddSchema = z.object({
  content: z.string().min(1).max(100_000).describe("The memory content to store"),
  layer: Layer.describe("Cognitive layer: episodic=events/sessions, semantic=facts/concepts, procedural=rules/workflows, resource=reference material"),
  title: z.string().max(500).optional().describe("Optional short title for the memory"),
  entity_type: EntityType.optional().describe("Entity this memory is about"),
  entity_name: z.string().max(500).optional().describe("Name of the entity (e.g. 'nikita', 'mnemon-mcp')"),
  event_at: isoDatePrefix.optional().describe("ISO 8601 datetime when the event occurred (episodic layer)"),
  ttl_days: z.number().positive().optional().describe("Days until this memory expires (null = never)"),
  confidence: z.number().min(0).max(1).optional().describe("How certain this memory is (0.0–1.0, default 0.8)"),
  importance: z.number().min(0).max(1).optional().describe("Retrieval priority weight (0.0–1.0, default 0.5)"),
  scope: z.string().max(200).optional().describe("Project/context scope (default 'global')"),
  source: z.string().max(200).optional().describe("Source identifier (e.g. 'claude-code', 'api')"),
  source_file: z.string().max(1000).optional().describe("Original file path for imports"),
  session_id: z.string().max(200).optional().describe("Session ID for grouping episodic memories"),
  meta: z.record(z.string(), z.unknown()).optional().describe("Additional metadata (layer-specific fields)"),
  valid_from: isoDatePrefix.optional().describe("ISO 8601 date when this fact becomes valid (null = always valid)"),
  valid_until: isoDatePrefix.optional().describe("ISO 8601 date when this fact stops being valid (null = no end date)"),
});

export const MemorySearchSchema = z.object({
  query: z.string().min(1).max(10_000).describe("Search query — free text, tokenized for FTS5"),
  layers: z.array(Layer).optional().describe("Filter by memory layers (default: all layers)"),
  entity_name: z.string().max(500).optional().describe("Filter by entity name (exact match, supports aliases)"),
  scope: z.string().max(200).optional().describe("Filter by scope (exact match)"),
  date_from: isoDatePrefix.optional().describe("Filter by event date (event_at if set, else created_at) >= ISO 8601 datetime"),
  date_to: isoDatePrefix.optional().describe("Filter by event date (event_at if set, else created_at) <= ISO 8601 datetime"),
  min_confidence: z.number().min(0).max(1).optional().describe("Minimum confidence threshold"),
  min_importance: z.number().min(0).max(1).optional().describe("Minimum importance threshold"),
  include_superseded: z.boolean().optional().describe("Include superseded (outdated) memories in results (default false)"),
  limit: z.number().min(1).max(100).optional().describe("Maximum results to return (default 10, max 100)"),
  offset: z.number().min(0).optional().describe("Number of results to skip (for pagination, default 0)"),
  mode: SearchMode.optional().describe("Search mode: fts=FTS5 tokenized (default), exact=LIKE substring, vector=embedding similarity (requires MNEMON_EMBEDDING_PROVIDER), hybrid=FTS5+vector with RRF fusion"),
  as_of: isoDatePrefix.optional().describe("ISO 8601 date to filter temporal facts. Only returns memories where valid_from <= as_of and valid_until >= as_of (nulls treated as unbounded)."),
});

export const MemoryUpdateSchema = z.object({
  id: z.string().min(1).describe("ID of the memory to update"),
  content: z.string().max(100_000).optional().describe("New content. For in-place update (supersede=false): replaces content directly. For supersede=true: used as fallback if new_content is not provided."),
  title: z.string().max(500).optional().describe("New title"),
  confidence: z.number().min(0).max(1).optional().describe("New confidence score"),
  importance: z.number().min(0).max(1).optional().describe("New importance score"),
  meta: z.record(z.string(), z.unknown()).optional().describe("Metadata fields to merge into existing meta JSON"),
  supersede: z.boolean().optional().describe("When true, creates a new entry that supersedes this one (preserves history). When false (default), updates fields in place."),
  new_content: z.string().max(100_000).optional().describe("Content for the superseding entry (used only when supersede=true). Falls back to `content` if omitted."),
});

export const MemoryInspectSchema = z.object({
  id: z.string().optional().describe("Memory ID to inspect. When provided, returns the full memory row and optionally its history chain."),
  layer: Layer.optional().describe("Filter layer stats by this layer (used when id is omitted)"),
  entity_name: z.string().max(500).optional().describe("Filter stats by entity name (used when id is omitted)"),
  include_history: z.boolean().optional().describe("When true and id is provided, include the full superseded chain (ancestor entries)"),
});

export const MemoryExportSchema = z.object({
  format: ExportFormat.describe("Export format: json (structured), markdown (human-readable), claude-md (compact for LLM context)"),
  layers: z.array(Layer).optional().describe("Filter by memory layers (omit for all)"),
  scope: z.string().max(200).optional().describe("Filter by scope (e.g. 'global', 'project-name')"),
  include_superseded: z.boolean().optional().describe("Include superseded (old version) memories (default: false)"),
  date_from: isoDatePrefix.optional().describe("Filter: event date (event_at if set, else created_at) >= ISO 8601 date"),
  date_to: isoDatePrefix.optional().describe("Filter: event date (event_at if set, else created_at) <= ISO 8601 date"),
  limit: z.number().min(1).max(10_000).optional().describe("Maximum entries to export (default 1000, max 10000)"),
});

export const MemoryDeleteSchema = z.object({
  id: z.string().min(1).describe("ID of the memory to permanently delete"),
});

export const MemoryHealthSchema = z.object({
  cleanup: z.boolean().optional().describe("When true, garbage-collect expired entries (TTL past due). Default false — report only."),
});

export const SessionStartSchema = z.object({
  client: z.string().min(1).max(200).describe("Client identifier (e.g. 'claude-code', 'cursor', 'api')"),
  project: z.string().max(500).optional().describe("Project scope for this session"),
  meta: z.record(z.string(), z.unknown()).optional().describe("Additional session metadata"),
});

export const SessionEndSchema = z.object({
  id: z.string().min(1).describe("Session ID to end"),
  summary: z.string().max(10_000).optional().describe("Summary of what was accomplished in this session"),
});

export const SessionListSchema = z.object({
  limit: z.number().min(1).max(100).optional().describe("Maximum sessions to return (default 20)"),
  client: z.string().max(200).optional().describe("Filter by client identifier"),
  project: z.string().max(500).optional().describe("Filter by project"),
  active_only: z.boolean().optional().describe("Only return sessions that haven't ended yet (default false)"),
});

/**
 * Convert a Zod schema to MCP-compatible JSON Schema.
 * Strips $schema and additionalProperties fields that MCP doesn't use.
 */
export function zodToToolSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema["$schema"];
  delete jsonSchema["additionalProperties"];
  return jsonSchema;
}

// Pre-generated tool schemas (used in server.ts for tool registration)
export const memoryAddToolSchema = zodToToolSchema(MemoryAddSchema);
export const memorySearchToolSchema = zodToToolSchema(MemorySearchSchema);
export const memoryUpdateToolSchema = zodToToolSchema(MemoryUpdateSchema);
export const memoryInspectToolSchema = zodToToolSchema(MemoryInspectSchema);
export const memoryExportToolSchema = zodToToolSchema(MemoryExportSchema);
export const memoryDeleteToolSchema = zodToToolSchema(MemoryDeleteSchema);
export const memoryHealthToolSchema = zodToToolSchema(MemoryHealthSchema);
export const sessionStartToolSchema = zodToToolSchema(SessionStartSchema);
export const sessionEndToolSchema = zodToToolSchema(SessionEndSchema);
export const sessionListToolSchema = zodToToolSchema(SessionListSchema);
