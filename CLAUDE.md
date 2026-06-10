---
last_updated: 2026-03-17
description: mnemon-mcp — persistent layered memory MCP server for AI agents
---

# mnemon-mcp

MCP server providing persistent layered memory for AI agents.
SQLite + FTS5 backend, zero-cloud, stdio transport.

Part of the Mnemon ecosystem. KB lives in `~/dev/mnemon/mnemon-kb`.
Task board shared with KB: `~/dev/mnemon/mnemon-kb/tasks/BOARD.md` (T-NNN IDs).

## Commands

```bash
npm run build      # compile TypeScript → dist/
npm run dev        # run via tsx (no build needed)
npm start          # run compiled dist/index.js (blocks on stdio — see Smoke Test)
npm test           # vitest (231 tests: 23 md-parser + 15 kb-import + 27 date-extractor + 125 integration + 41 validation)
npm run import:kb  # import mnemon-kb markdown → SQLite (skip unchanged)
```

Full re-import (ignore hashes, rewrite all):
```bash
npx tsx src/import/cli.ts --kb-path ~/dev/mnemon/mnemon-kb --force
```

Smoke test (verify server responds to JSON-RPC):
```bash
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js
```

## Tech Stack

| Tool | Version | Purpose |
|------|---------|---------|
| TypeScript | 5.9 | Strict mode, NodeNext modules |
| better-sqlite3 | 12.6 | Synchronous SQLite (ideal for MCP stdio) |
| @modelcontextprotocol/sdk | 1.27 | MCP server framework |
| zod | 4.3 | Runtime input validation |
| snowball-stemmer.jsx | 0.2.3 | Russian/English stemming |
| vitest | 3.2 | Test runner |
| tsx | 4.21 | TypeScript execution without build step |

## Architecture

```
src/
  index.ts              MCP server entry (stdio transport, tool dispatch)
  index-http.ts         HTTP transport entry (StreamableHTTP, Bearer auth)
  db.ts                 SQLite schema, migrations, indexes, FTS5 triggers
  types.ts              TypeScript types (mirrors SQLite schema)
  tools/
    memory-add.ts       Insert memory, auto-supersede on source_file match
    memory-search.ts    FTS5 search with layer/scope/date filtering, recency boost, query-centered snippets
    memory-update.ts    In-place update or superseding chain
    memory-inspect.ts   Layer stats or single-memory history trace
    memory-export.ts    Export to json/markdown/claude-md with layer/scope/date filters
    memory-health.ts    Diagnostic report + optional expired entry cleanup
    session.ts          Session lifecycle: start, end, list
    style-extract.ts    [STUB] Writing style analysis
  import/
    cli.ts              CLI entry for KB import
    kb-config.ts        Import routing rules (which files → which layer)
    kb-import.ts        Bulk import engine (hash-based dedup)
    md-parser.ts        Markdown → memory records splitter
    __tests__/
      md-parser.test.ts 14 unit tests
```

## Database

- **Path:** `~/.mnemon-mcp/memory.db`
- **WAL mode**, foreign keys ON, busy_timeout 5000ms
- **Tables:** memories, sessions, import_log, event_log, search_log, entity_aliases
- **FTS5:** `memories_fts` synced via INSERT/UPDATE/DELETE triggers
- **Partial indexes:** exclude superseded entries from search
- **Tokenizer:** unicode61 (Cyrillic + Latin, NOT Thai-friendly)
- **Index-time stemming:** Snowball stemmer (EN + RU), stored in `stemmed_content`/`stemmed_title` columns, FTS5 indexes stemmed forms

## 4-Layer Memory Model

| Layer | Access pattern | Staleness | Examples |
|-------|---------------|-----------|----------|
| episodic | By date/period | Never expires | Journal, session notes |
| semantic | By topic/entity | 30-90 days | Facts, people, beliefs |
| procedural | Loaded at startup | Rare updates | CLAUDE.md rules |
| resource | On demand | Static | Book summaries, references |

## MCP Tools

| Tool | Status | Description |
|------|--------|-------------|
| memory_add | Working | Insert with auto-supersede on source_file match, contradiction detection |
| memory_search | Working | FTS5 with layer/entity/date/scope/as_of filters, recency boost, query-centered snippets |
| memory_update | Working | In-place or superseding chain |
| memory_delete | Working | Delete memory with chain cleanup |
| memory_inspect | Working | Stats per layer or single memory history |
| memory_export | Working | Export to json/markdown/claude-md with filters |
| memory_health | Working | Diagnostic report: expired, orphaned, stale, low-confidence. Optional cleanup |
| memory_session_start | Working | Start agent session, returns session ID for grouping memories |
| memory_session_end | Working | End session with optional summary, returns duration + memory count |
| memory_session_list | Working | List sessions with filters (client, project, active_only) |
| style_extract | Stub | Throws "not implemented" |

### MCP Resources

| URI | Description |
|-----|-------------|
| `memory://stats` | Aggregate statistics per layer |
| `memory://recent` | Memories created/updated in last 24h |
| `memory://layer/{layer}` | Active memories in a specific layer |
| `memory://entity/{name}` | Active memories about a specific entity |

### MCP Prompts

| Prompt | Description |
|--------|-------------|
| `recall` | Recall everything known about a topic |
| `context-load` | Load relevant context for a task |
| `journal` | Create structured journal entry |

## MCP Config

In `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "mnemon-mcp": {
      "command": "node",
      "args": ["/Users/nikitagorokhov/dev/mnemon/mnemon-mcp/dist/index.js"]
    }
  }
}
```

## Key Files in mnemon-kb

| File | Purpose |
|------|---------|
| `ai-tools/mnemon-mcp-schema.md` | Full SQLite schema reference |
| `ai-tools/mnemon-roadmap-2026-03.md` | Roadmap and architecture decisions |
| `eval/EVAL-SPEC.md` | Eval framework spec (L0-L3) |
| `eval/data/golden_set.json` | 50 test cases for retrieval quality |
| `eval/scripts/step2_retrieval.py` | L2 eval — queries this DB directly |
| `ai-tools/mnemon-memory-architecture-target-spec-2026-03-08.md` | Target state architecture |
| `ai-tools/memory-consolidate-and-consolidation-schema-2026-03-08.md` | Consolidation worker spec (T-079) |
| `tasks/BOARD.md` | Shared task board for both KB and MCP |

## Known Issues

1. **Russian morphology** — Snowball stemmer fully integrated at index and query time with bilingual month expansion (EN↔RU). Edge cases with irregular forms may still miss.
2. **L2 retrieval (MCP hybrid) = 92.6/100** — Recall@5=0.931, MRR=0.888, nDCG@5=0.876. FTS-only=87.8. Up from 36.9 baseline
3. **231 tests** — 23 md-parser + 15 kb-import + 27 date-extractor + 125 integration + 41 validation
4. **Hybrid soft regressions** — FAC-002, XRF-001 regress in hybrid vs FTS (vector noise dilutes strong FTS signal via RRF). Overall hybrid still +4.8 over FTS
5. **No cycle protection** in superseding chains

## Superseding Chain

When `memory_update(supersede=true)`:
1. New entry created with `supersedes = old.id`
2. Old entry's `superseded_by` set to new entry's id
3. Partial indexes exclude old entry from search
4. No cycle protection yet (known issue)

## Critical Rules

1. **Never write to stdout from MCP tools** — `console.log()` breaks JSON-RPC stdio transport. Use `console.error()` or write to a file for debugging
2. **Build before committing** if `src/` changed: `npm run build`
3. **Run tests before committing**: `npm test`
4. **Sync with KB** — after schema changes, update `~/dev/mnemon/mnemon-kb/ai-tools/mnemon-mcp-schema.md`

## Conventions

- Commit format: `verb: description` (follows global CLAUDE.md)
- Push to `origin` (https://github.com/nikitacometa/mnemon-mcp.git)

## Architecture Decisions

- **better-sqlite3 (sync)** over async alternatives — MCP stdio transport is inherently synchronous; async DB would add complexity with no benefit
- **FTS5 over FTS3/4** — BM25 ranking, highlight(), snippet() support
- **unicode61 tokenizer** — handles Cyrillic + Latin. Snowball stemmer applied at index and query time for morphological matching
