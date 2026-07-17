/**
 * Shared MCP server factory — used by both stdio and HTTP entry points.
 *
 * Centralizes tool registration, dispatch, and config loading so that
 * index.ts and index-http.ts only handle transport-specific concerns.
 */

import type Database from "better-sqlite3";
import { createRequire } from "node:module";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { memoryAdd } from "./tools/memory-add.js";
import { memorySearch } from "./tools/memory-search.js";
import { memoryUpdate } from "./tools/memory-update.js";
import { memoryInspect } from "./tools/memory-inspect.js";
import { memoryExport } from "./tools/memory-export.js";
import { memoryDelete } from "./tools/memory-delete.js";
import { memoryHealth } from "./tools/memory-health.js";
import { sessionStart, sessionEnd, sessionList } from "./tools/session.js";

import {
  MemoryAddSchema,
  MemorySearchSchema,
  MemoryUpdateSchema,
  MemoryInspectSchema,
  MemoryExportSchema,
  MemoryDeleteSchema,
  MemoryHealthSchema,
  SessionStartSchema,
  SessionEndSchema,
  SessionListSchema,
  memoryAddToolSchema,
  memorySearchToolSchema,
  memoryUpdateToolSchema,
  memoryInspectToolSchema,
  memoryExportToolSchema,
  memoryDeleteToolSchema,
  memoryHealthToolSchema,
  sessionStartToolSchema,
  sessionEndToolSchema,
  sessionListToolSchema,
} from "./validation.js";

import type {
  MemoryAddInput,
  MemorySearchInput,
  MemoryUpdateInput,
  MemoryInspectInput,
  MemoryExportInput,
  MemoryDeleteInput,
  MemoryHealthInput,
  SessionStartInput,
  SessionEndInput,
  SessionListInput,
} from "./types.js";

import type { Embedder } from "./embedder.js";
import { upsertVec, deleteVec, isVecLoaded } from "./vector.js";

import { loadConfig } from "./import/config-loader.js";
import { addExtraStopWords } from "./stop-words.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export { version };

/** Load extra stop words from config (best-effort, non-fatal). */
export function loadExtraStopWords(): void {
  try {
    const config = loadConfig();
    if (config.extraStopWords.length > 0) {
      addExtraStopWords(config.extraStopWords);
    }
  } catch {
    // Config loading is best-effort for the MCP server
  }
}

/** Create an MCP server with all memory tools registered. */
export function createMcpServer(db: Database.Database, embedder?: Embedder | null): Server {
  const server = new Server(
    { name: "mnemon-mcp", version },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "memory_add",
        description:
          "Add a new memory to the persistent store. Supports 4 cognitive layers: episodic (events/sessions), semantic (facts/concepts), procedural (rules/workflows), resource (reference material). Automatically supersedes previous entries from the same source_file.",
        inputSchema: memoryAddToolSchema,
      },
      {
        name: "memory_search",
        description:
          "Full-text search across all memory layers using FTS5. Supports layer/entity/date/scope filtering. Returns scored results with snippets. Superseded entries excluded by default.",
        inputSchema: memorySearchToolSchema,
      },
      {
        name: "memory_update",
        description:
          "Update an existing memory. Use supersede=true to create a versioned replacement (preserves history chain). Use supersede=false (default) to update fields in place.",
        inputSchema: memoryUpdateToolSchema,
      },
      {
        name: "memory_delete",
        description:
          "Permanently delete a memory by ID. Cleans up superseding chain references: re-activates predecessor if one exists.",
        inputSchema: memoryDeleteToolSchema,
      },
      {
        name: "memory_inspect",
        description:
          "Inspect memory details or layer statistics. Without id: returns aggregate stats per layer (total, active, superseded, avg_confidence, top_entities). With id: returns the full memory row and optionally its history chain.",
        inputSchema: memoryInspectToolSchema,
      },
      {
        name: "memory_export",
        description:
          "Export memories to JSON, Markdown, or claude-md (compact LLM-optimized) format. Supports filtering by layer, scope, date range. Returns the exported content as a string.",
        inputSchema: memoryExportToolSchema,
      },
      {
        name: "memory_health",
        description:
          "Diagnostic health report on the memory store. Returns expired entries, orphaned superseding chains, stale/never-accessed memories, low-confidence entries, and per-layer stats. Use cleanup=true to garbage-collect expired entries.",
        inputSchema: memoryHealthToolSchema,
      },
      {
        name: "memory_session_start",
        description:
          "Start a new agent session. Returns session ID that can be passed to memory_add(session_id=...) to group memories. Use at the beginning of a work session.",
        inputSchema: sessionStartToolSchema,
      },
      {
        name: "memory_session_end",
        description:
          "End an active session. Optionally attach a summary of what was accomplished. Returns duration and count of memories created during the session.",
        inputSchema: sessionEndToolSchema,
      },
      {
        name: "memory_session_list",
        description:
          "List recent sessions with their metadata. Supports filtering by client, project, and active-only. Returns memories count per session.",
        inputSchema: sessionListToolSchema,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "memory_add": {
          const input = MemoryAddSchema.parse(args) as MemoryAddInput;
          const result = memoryAdd(db, input);
          // Auto-embed if embedder configured and sqlite-vec loaded
          if (embedder && isVecLoaded()) {
            try {
              const textToEmbed = input.title
                ? `${input.title}\n\n${input.content}`
                : input.content;
              const embedding = await embedder.embed(textToEmbed);
              upsertVec(db, result.id, embedding, embedder);
            } catch {
              // Embedding is best-effort — don't fail the add
            }
          }
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "memory_search": {
          const input = MemorySearchSchema.parse(args) as MemorySearchInput;
          const result = await memorySearch(db, input, embedder);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "memory_update": {
          const input = MemoryUpdateSchema.parse(args) as MemoryUpdateInput;
          const result = memoryUpdate(db, input);
          // Re-embed updated or new (superseded) memory
          if (embedder && isVecLoaded()) {
            try {
              const activeId = result.new_id ?? result.updated_id;
              const row = db.prepare<[string], { title: string | null; content: string }>(
                "SELECT title, content FROM memories WHERE id = ?"
              ).get(activeId);
              if (row) {
                const text = row.title ? `${row.title}\n\n${row.content}` : row.content;
                const embedding = await embedder.embed(text);
                upsertVec(db, activeId, embedding, embedder);
              }
              // Remove stale vector for superseded entry
              if (result.new_id) {
                deleteVec(db, result.updated_id);
              }
            } catch {
              // Best-effort
            }
          }
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "memory_delete": {
          const input = MemoryDeleteSchema.parse(args) as MemoryDeleteInput;
          const result = memoryDelete(db, input);
          // Remove vector for deleted memory
          if (isVecLoaded()) {
            deleteVec(db, input.id);
          }
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "memory_inspect": {
          const input = MemoryInspectSchema.parse(args) as MemoryInspectInput;
          const result = memoryInspect(db, input);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "memory_export": {
          const input = MemoryExportSchema.parse(args) as MemoryExportInput;
          const result = memoryExport(db, input);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "memory_health": {
          const input = MemoryHealthSchema.parse(args ?? {}) as MemoryHealthInput;
          const result = memoryHealth(db, input);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "memory_session_start": {
          const input = SessionStartSchema.parse(args) as SessionStartInput;
          const result = sessionStart(db, input);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "memory_session_end": {
          const input = SessionEndSchema.parse(args) as SessionEndInput;
          const result = sessionEnd(db, input);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "memory_session_list": {
          const input = SessionListSchema.parse(args ?? {}) as SessionListInput;
          const result = sessionList(db, input);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.stack ?? err.message : String(err);
      process.stderr.write(`[mnemon-mcp] tool ${name} error: ${detail}\n`);
      // Return generic message to client — never leak SQL/schema/path internals
      const safeMessage = err instanceof Error && err.message.length < 200
        ? err.message.replace(/\/[^\s]+/g, "<path>")
        : "Tool execution failed";
      return {
        content: [{ type: "text", text: `Error: ${safeMessage}` }],
        isError: true,
      };
    }
  });

  // -----------------------------------------------------------------------
  // MCP Resources — read-only data endpoints for memory browsing
  // -----------------------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      {
        uri: "memory://stats",
        name: "Memory Statistics",
        description: "Aggregate statistics per memory layer: totals, active count, avg confidence/importance, top entities",
        mimeType: "application/json",
      },
      {
        uri: "memory://recent",
        name: "Recent Memories",
        description: "Memories created or updated in the last 24 hours",
        mimeType: "application/json",
      },
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [
      {
        uriTemplate: "memory://layer/{layer}",
        name: "Memories by Layer",
        description: "List active memories in a specific layer (episodic, semantic, procedural, resource)",
        mimeType: "application/json",
      },
      {
        uriTemplate: "memory://entity/{name}",
        name: "Memories by Entity",
        description: "List active memories about a specific entity",
        mimeType: "application/json",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const { uri } = request.params;

    if (uri === "memory://stats") {
      const result = memoryInspect(db, {});
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify(result, null, 2),
        }],
      };
    }

    if (uri === "memory://recent") {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const rows = db.prepare<[string], { id: string; layer: string; title: string | null; content: string; created_at: string }>(
        `SELECT id, layer, title, content, created_at FROM memories
         WHERE superseded_by IS NULL AND COALESCE(updated_at, created_at) >= ?
         ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50`
      ).all(since);
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ since, count: rows.length, memories: rows }, null, 2),
        }],
      };
    }

    const VALID_LAYERS = ["episodic", "semantic", "procedural", "resource"];
    const layerMatch = uri.match(/^memory:\/\/layer\/(\w+)$/);
    if (layerMatch) {
      const layer = layerMatch[1]!;
      if (!VALID_LAYERS.includes(layer)) {
        throw new Error(`Invalid layer: "${layer}". Must be one of: ${VALID_LAYERS.join(", ")}`);
      }
      const rows = db.prepare<[string], { id: string; title: string | null; content: string; entity_name: string | null; importance: number; created_at: string }>(
        `SELECT id, title, content, entity_name, importance, created_at FROM memories
         WHERE layer = ? AND superseded_by IS NULL
         ORDER BY importance DESC, created_at DESC LIMIT 100`
      ).all(layer);
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ layer, count: rows.length, memories: rows }, null, 2),
        }],
      };
    }

    const entityMatch = uri.match(/^memory:\/\/entity\/(.+)$/);
    if (entityMatch) {
      const name = decodeURIComponent(entityMatch[1]!);
      const rows = db.prepare<[string], { id: string; layer: string; title: string | null; content: string; importance: number; created_at: string }>(
        `SELECT id, layer, title, content, importance, created_at FROM memories
         WHERE entity_name = ? AND superseded_by IS NULL
         ORDER BY importance DESC, created_at DESC LIMIT 100`
      ).all(name);
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ entity_name: name, count: rows.length, memories: rows }, null, 2),
        }],
      };
    }

    throw new Error(`Unknown resource URI: ${uri}`);
  });

  // -----------------------------------------------------------------------
  // MCP Prompts — pre-built prompt templates for common memory operations
  // -----------------------------------------------------------------------

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [
      {
        name: "recall",
        description: "Recall everything known about a topic from memory",
        arguments: [
          { name: "topic", description: "What to recall (e.g. 'human design', 'project architecture')", required: true },
        ],
      },
      {
        name: "context-load",
        description: "Load relevant context for a task into the conversation",
        arguments: [
          { name: "task", description: "The task you're about to work on", required: true },
          { name: "scope", description: "Optional scope filter (e.g. 'mnemon-mcp', 'personal')", required: false },
        ],
      },
      {
        name: "journal",
        description: "Create a structured journal/session entry from a summary",
        arguments: [
          { name: "summary", description: "What happened in this session", required: true },
        ],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "recall": {
        const topic = args?.["topic"] ?? "general";
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `Search your memory for everything related to: "${topic}"\n\nUse memory_search with different queries and filters to find all relevant information. Try:\n1. FTS search for the topic directly\n2. Search with entity_name if it's about a specific person/concept/project\n3. Search across different layers (episodic for events, semantic for facts, procedural for rules)\n\nSynthesize the results into a comprehensive answer. If memories conflict, note the most recent version.`,
              },
            },
          ],
        };
      }

      case "context-load": {
        const task = args?.["task"] ?? "current task";
        const scope = args?.["scope"];
        const scopeHint = scope ? `\nFilter by scope: "${scope}"` : "";
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `Load relevant context for this task: "${task}"${scopeHint}\n\nSearch memory for:\n1. Procedural rules and conventions related to this task\n2. Semantic facts about the entities involved\n3. Recent episodic context (sessions, decisions, discussions)\n4. Relevant resources (references, documentation)\n\nPresent the loaded context as a structured briefing.`,
              },
            },
          ],
        };
      }

      case "journal": {
        const summary = args?.["summary"] ?? "";
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `Create a journal entry from this session summary:\n\n${summary}\n\nUse memory_add with:\n- layer: "episodic"\n- entity_type: "user"\n- event_at: current ISO timestamp\n- importance: 0.6\n- confidence: 0.9\n\nExtract any new facts, decisions, or preferences mentioned and store them as separate semantic memories.`,
              },
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  });

  return server;
}
