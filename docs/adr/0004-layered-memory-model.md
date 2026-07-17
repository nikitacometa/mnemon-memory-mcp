# ADR-0004: Four typed memory layers instead of a flat store

**Status:** Accepted
**Date:** 2026-03-05 (documented retroactively 2026-07-17)

## Context

Most MCP memory servers store memories as a flat collection with uniform
ranking. But "what happened last Tuesday", "the user prefers tabs", and
"never deploy on Friday" are different kinds of knowledge: they are asked
for differently, age differently, and cost differently when wrong.

The agent-memory literature converged on the same split (episodic / semantic
/ procedural taxonomies in EMNLP/NeurIPS 2025 memory papers); this design
predates none of it — it borrows it deliberately.

## Decision

Every memory belongs to exactly one of four layers, and the layer drives
retrieval behavior, not just labeling:

| Layer | Access pattern | Decay in ranking | Typical content |
|-------|----------------|------------------|-----------------|
| `episodic` | by date/period | 30-day half-life | journal, session notes, events |
| `semantic` | by topic/entity | none (stable) | facts, preferences, people |
| `procedural` | loaded at startup | none (rare updates) | rules, conventions |
| `resource` | on demand | 90-day half-life | book notes, reference material |

Mechanics that hang off the layer:

- **Decay multiplier** in the search score — an episodic note from last year
  should lose to yesterday's unless importance says otherwise; a procedural
  rule must never decay.
- **Import routing** — the KB import config maps glob patterns to layers, so
  a markdown journal lands in `episodic` while `people/*.md` lands in
  `semantic` with entity extraction.
- **Layer filters** in every search/export/inspect tool.

Orthogonal to layers, two more axes complete the lifecycle model:
**superseding chains** (fact versioning — updates link, never overwrite) and
**temporal validity windows** (`valid_from`/`valid_until` + `as_of` queries).

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Flat store + tags | Tags don't change ranking or lifecycle; every client reinvents decay |
| Knowledge graph (Graphiti-style) | Needs Neo4j/FalkorDB + LLM extraction; violates zero-deps |
| Two layers (short/long-term) | Loses the procedural/resource distinction that drives decay policy |

## Consequences

- The layer enum is load-bearing: schema CHECK constraint, Zod validation,
  scoring, import routing, and eval golden-set categories all reference it.
- Choosing a layer is a real decision for the writing agent; tool
  descriptions carry explicit guidance to keep the choice consistent.
