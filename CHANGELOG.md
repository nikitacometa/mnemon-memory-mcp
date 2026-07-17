# Changelog

All notable changes to mnemon-mcp will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `from-frontmatter` entity_name resolution — per-entity KB files declare `entity:` in frontmatter
- `expired_count` in `memory_health` report — total expired rows matching the cleanup predicate
- `MNEMON_HOST` variable for the HTTP transport bind address

### Security
- HTTP transport binds to `127.0.0.1` by default; non-loopback binds require `MNEMON_AUTH_TOKEN` or an explicit `MNEMON_ALLOW_INSECURE_HTTP=1` opt-in
- CORS is now opt-in via `MNEMON_CORS_ORIGIN` (previously defaulted to `*`)

### Fixed
- BM25 field weights were silently shifted onto the wrong columns by the unindexed `id` column — actual weighting was title=1/content=2 instead of the documented title=3/content=1/entity=2
- Pure date-range queries applied the importance boost twice, squaring its effect on ranking
- Pure date-range queries now honor the `as_of` temporal filter like every other search mode
- Fully-date queries ("в марте 2025") now route to date-range search instead of FTS-matching the date words themselves
- Expired-entry cleanup crashed with an FK violation (rolling back the whole cleanup) when adjacent supersede-chain links expired together
- Calendar validation rejects impossible dates (e.g. February 31) instead of silently normalizing them
- Incremental KB import compares only the latest import per file, so files reverted to earlier content re-import correctly

## [1.3.0] - 2026-03-18

### Added
- `has_more` pagination flag in `memory_search` response
- Stem-aware snippet centering — snippets anchor on the stemmed match, not the raw substring
- Adaptive FTS weighting in hybrid RRF — 1.5× FTS weight when the FTS signal is strong
- `embedding_model` exposed in `memory_inspect` output (raw embedding BLOB removed from API surface)
- Migration v7: drop legacy `embedding` column; idempotent migration guards (`safeAddColumn`/`safeDropColumn`)
- Warning log when a `source_file` supersede matches multiple records

### Changed
- **Breaking:** `total_found` renamed to `returned_count` in `memory_search` response

### Fixed
- Export date filters wrap column in `date()` — fixes ISO datetime vs date-only comparison
- Search log records the resolved search mode instead of the requested one
- Config loader wraps user-supplied regex patterns in try/catch instead of crashing on invalid input
- `sqlite-vec` loaded state bound to the db instance instead of a module-level singleton

## [1.2.0] - 2026-03-18

### Added
- **Hybrid search** — FTS5 + vector via Reciprocal Rank Fusion (RRF, k=60). Auto-enabled when embedding provider is configured. L2 eval: 92.6/100 (up from 80.9 FTS-only)
- **Structured date extraction** — Russian natural language dates ("3 марта 2026", "в феврале–марте 2025") auto-parsed into SQL WHERE filters with query term stripping
- **Embedding backfill CLI** — `npm run embed:backfill` batch-embeds active memories via configured provider (OpenAI/Ollama). Supports `--force`, `--batch-size`, text truncation for token limits
- **Section-level `event_at` extraction** — import pipeline now extracts dates from H2/H3 section titles, not just filenames
- **Cross-reference query expansion** — queries mentioning entities expand to include related terms for better recall
- **Bilingual month expansion** — EN↔RU month names added at both index and query time ("march" matches "марта" and vice versa)
- **Document-type stop words** — "дневник", "журнал", "запись" forms filtered from FTS queries to reduce noise
- `source_file` field in `memory_search` response — enables eval file matching and provenance tracking
- `embedding_model` column (migration v6) — tracks which model embedded each memory
- 33 new tests: 6 md-parser + 27 date-extractor + 2 integration (229 total)

### Fixed
- **BM25 score inversion** — `1/(1+|rank|)` inverted relevance ordering; corrected to `|rank|/(1+|rank|)` (+9 L2 points)
- **Single-quote FTS5 crash** — queries with apostrophes now escaped before MATCH
- **ё→е normalization** — "ёлка" now matches "елка" in both indexing and search
- **AND relaxation tuning** — relaxed from top-3 stems at 4+ tokens to top-2 at 3+, improving recall on short queries
- **session_id validation** — `memory_add` now verifies session_id FK exists before insert
- **Error sanitization** — tool errors return generic messages to MCP clients; full stack traces logged to stderr only
- **Date validation** — `isoDatePrefix` now rejects structurally invalid dates (month 13, day 00) via `Date.parse` refine
- **`search_log` retention** — probabilistic pruning removes entries older than 90 days (~1% of writes)
- Removed stale `dist/tools/style-extract.*` build artifacts from npm package
- Excluded `dist/.tsbuildinfo` (79 KB) from npm package

## [1.1.0] - 2026-03-17

### Added
- **Session lifecycle tools**: `memory_session_start`, `memory_session_end`, `memory_session_list` — group episodic memories by agent session with client, project, and summary tracking
- **Search query logging** — `search_log` table (migration v5) for query observability: query text, mode, result count, duration
- **Recency boost** in FTS scoring: `1 / (1 + daysSince / 365)` rewards recently created memories
- **Query-centered snippets** — search results highlight the first matched term instead of always starting from content beginning
- 12 new integration tests for session lifecycle (194 total: 17 md-parser + 13 kb-import + 123 integration + 41 validation)

### Fixed
- Pagination with `min_confidence`/`min_importance` filters: moved from JS post-filter to SQL WHERE (fixes empty pages at high offsets)
- `memory_health` cleanup: chain repair now correctly reactivates predecessors when superseding entry is deleted
- Contradiction detection: properly handles edge case where superseded memory matches source_file
- Removed dead `conflicting` variable in memory-add

## [1.0.1] - 2026-03-16

### Added
- MCP Registry manifest (`server.json`) for official registry submission
- `mcpName` field in package.json for registry verification
- Landing page link in README
- Demo GIF with VHS recording scripts

### Changed
- Homepage URL updated to landing page (aisatisfy.me/mnemon/)

## [1.0.0] - 2026-03-16

### Added
- 4-layer memory model: episodic, semantic, procedural, resource
- 7 MCP tools: `memory_add`, `memory_search`, `memory_update`, `memory_delete`, `memory_inspect`, `memory_export`, `memory_health`
- FTS5 full-text search with BM25 ranking and AND→OR fallback
- Snowball stemming for English and Russian at index and query time
- Progressive AND relaxation for complex multi-token queries
- Fact versioning via superseding chains
- Markdown knowledge base import pipeline with configurable routing
- Temporal fact windows (valid_from / valid_until) and entity aliases
- Memory decay scoring (episodic: 30-day, resource: 90-day half-life)
- Contradiction detection on memory_add
- `memory_health` tool: diagnostic report with expired entries, orphaned chains, stale memories, and optional GC
- MCP Resources (stats, recent, layer, entity) and Prompts (recall, context-load, journal)
- HTTP transport with Bearer auth, CORS, rate limiting, body size limits, graceful shutdown
- Optional vector search with BYOK embeddings (OpenAI, Ollama) via sqlite-vec
- Hybrid search mode combining FTS5 + vector via Reciprocal Rank Fusion (RRF)
- Tool input schemas generated from Zod via `z.toJSONSchema()` — single source of truth
- Import config with Zod validation
- 182 tests (unit + integration + validation)
- CI pipeline with build, test, and smoke tests

[Unreleased]: https://github.com/nikitacometa/mnemon-memory-mcp/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/nikitacometa/mnemon-memory-mcp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/nikitacometa/mnemon-memory-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/nikitacometa/mnemon-memory-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/nikitacometa/mnemon-memory-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nikitacometa/mnemon-memory-mcp/releases/tag/v1.0.0
