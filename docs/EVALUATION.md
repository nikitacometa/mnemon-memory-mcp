# Retrieval evaluation

Retrieval quality is measured, not asserted. This document describes the
methodology, the current numbers, and the failures we know about.

## Methodology

**Golden set.** 50 hand-labeled cases (48 active; 2 excluded as out of import
scope) built against a real personal knowledge base of **797 memories**
(mixed Russian/English markdown: journal, people profiles, projects, book
notes). Each case is a natural query mapped to the file(s) a correct
retrieval must surface. Case families:

- **FAC** — factual lookups ("when did X happen", "what does N think about Y")
- **XRF** — cross-reference queries where the entity name is the main signal
  ("how does the book 'Essentialism' relate to the productivity system")
- **NEG** — negative controls: queries about things *not* in the corpus,
  scored on returning nothing confidently wrong
- date-scoped queries exercising natural-language date extraction (RU)

**Harness.** A Python runner spawns the compiled server (`dist/index.js`) as
a real MCP subprocess and issues `memory_search` calls over JSON-RPC — the
numbers measure the actual shipped TypeScript retrieval path, not a
reimplementation. The composite score weights Recall@5 at 40%, MRR 25%,
negative precision 20%, nDCG@5 15%.

**Caveat.** The corpus is a personal KB and cannot be published; the golden
set stays in a private sibling repo. The methodology and per-release numbers
are published here instead, and a synthetic public eval set is on the
roadmap. Treat the numbers as honest self-measurement, not a public
benchmark.

## Current results (2026-07-17, corpus = 797 memories)

Both modes measured the same day, on the same corpus and golden set,
through the real MCP server:

| Metric | FTS-only | Hybrid (FTS5 + vector, RRF) |
|--------|---------:|---------------------------:|
| **Composite L2 score** | 88.9 | **91.8** |
| Recall@5 | 0.907 | **0.919** |
| Recall@10 | 0.907 | **0.943** |
| MRR | 0.817 | **0.882** |
| nDCG@5 | 0.816 | **0.867** |
| Negative precision | 1.000 | 1.000 |
| Median eval wall-time | 0.5 s | 28 s (embedding calls) |

Hybrid buys most of its edge on MRR/nDCG — it does not just find the right
memory, it ranks it higher. Embeddings: OpenAI `text-embedding-3-small`
(1024 dims) via the BYOK embedder.

## History — the score is a trajectory, not a number

| Date | Corpus | Hybrid score | What changed |
|------|-------:|-------------:|--------------|
| 2026-03-10 | ~270 | 36.9 (FTS) | baseline; 21/50 cases blocked by import scope |
| 2026-03-17 | ~550 | 92.6 | import scope widened; hybrid RRF landed; BM25 inversion fix (+9 pts) |
| 2026-06-10 | 797 | 90.3 | corpus +42% after bulk imports — recency boost flooded top-K (tracked as T-107) |
| 2026-07-17 | 797 | **91.8** | ranking fixes: BM25 field-weight shift, double importance boost, date-query routing |

Two lessons the history taught us:

1. **Scores drift with the corpus.** The 92.6 → 90.3 drop was not a code
   regression — bulk re-imports made recently-created memories flood the
   recency boost. Publishing only peak numbers would have hidden that.
2. **Ranking bugs hide in passing tests.** The BM25 field-weight bug (the
   unindexed `id` column silently consumed the first weight argument, so
   actual weighting was title=1/content=2 instead of the documented
   title=3/content=1) survived 250+ green tests and was caught by an audit,
   then confirmed by exactly this eval: fixing it moved hybrid 90.3 → 91.8.

## Known failures

- **FAC-011** (both modes): an aggregation question ("how many books …") —
  the answer is not localized in any single memory, so top-K retrieval
  cannot satisfy it. Needs consolidation/aggregation, not better ranking.
- **2 hybrid soft regressions** (XRF family): when a lexical match is very
  strong, vector neighbors dilute it through RRF and demote the correct hit
  by a few positions. Net hybrid effect stays positive; candidates for
  fusion-weight tuning.

## Reproducing

The harness lives in the private KB repo (`eval/scripts/run_eval.py`,
`--step 2` for retrieval). Against your own corpus:

```bash
python eval/scripts/step2_retrieval.py --mode mcp --mcp-mode hybrid --json
```

It spawns `mnemon-mcp/dist/index.js`, so whatever you measure is what ships.
