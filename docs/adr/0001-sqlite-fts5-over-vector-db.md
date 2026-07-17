# ADR-0001: SQLite + FTS5 as the storage and retrieval core

**Status:** Accepted
**Date:** 2026-03-05 (documented retroactively 2026-07-17)

## Context

An MCP memory server needs durable storage plus text retrieval good enough
that an agent finds the right memory in the top-5 results. The obvious 2026
default is a vector database (Qdrant, Chroma, pgvector) with embeddings.
The project's hard constraints said otherwise:

- **Local-first, zero-cloud** — memories are personal data; nothing may leave
  the machine, and setup must not require API keys.
- **Zero-ops install** — `npm install -g` and done. No Docker, no Postgres,
  no external daemon.
- **Multilingual corpus** — the primary corpus is mixed Russian/English.
  Russian morphology breaks naive tokenizers ("книги" must match "книга").
- **Deterministic, explainable ranking** — an agent debugging its own memory
  needs reproducible scores, not an opaque similarity.

## Decision

Use a single SQLite file with the FTS5 extension as the primary index:

- `memories` table + `memories_fts` (FTS5, `unicode61 remove_diacritics 2`)
  kept in sync by INSERT/UPDATE/DELETE triggers.
- Snowball stemming (EN + RU) applied at **index time and query time** into
  dedicated `stemmed_content`/`stemmed_title` columns — FTS5 indexes stems,
  so morphological variants match without an embedding model.
- BM25 ranking with field weights (title=3, content=1, entity_name=2),
  then deterministic multipliers: importance boost, per-layer decay, recency.
- WAL mode, foreign keys ON, partial indexes scoped to
  `WHERE superseded_by IS NULL` so superseded chain links never pollute reads.

Embeddings are an **optional add-on** (see ADR-0002), never a requirement.

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Qdrant / Chroma / Milvus | External daemon or cloud; kills zero-ops install; embeddings mandatory |
| Postgres + pgvector | Full DBMS to operate for a single-user local tool; overkill |
| Elasticsearch / OpenSearch | JVM heap for a personal memory store; absurd footprint |
| Flat JSON (Anthropic reference KG) | No FTS, no ranking, linear scans; doesn't survive corpus growth |
| Markdown files + grep | No ranking, no versioning invariants, no structured filters |

## Consequences

- One file (`~/.mnemon-mcp/memory.db`) holds everything: backup = file copy.
- Sub-millisecond FTS queries at the current corpus size (~800 memories,
  FTS AND ≈ 0.25 ms in the vitest bench suite).
- Pure lexical search misses semantic associations ("ML" ↔ "нейросети") —
  measured on the golden set and addressed by optional hybrid retrieval
  (ADR-0002) rather than by making embeddings mandatory.
- FTS5 quirks become our problem: query escaping, tokenizer behavior around
  punctuation, and BM25's positional weight arguments (a real bug we shipped
  and later fixed — the unindexed `id` column silently consumed the first
  weight slot).
