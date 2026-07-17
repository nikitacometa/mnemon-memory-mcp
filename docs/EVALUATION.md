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

**Caveats.** Two, both worth knowing before trusting a digit:

1. The corpus is a personal KB and cannot be published; the golden set stays
   in a private sibling repo. The methodology and per-release numbers are
   published here instead, and a synthetic public eval set is on the roadmap.
   Treat these as honest self-measurement, not a public benchmark.
2. **The eval perturbs what it measures.** Every search updates
   `access_count`/`last_accessed`, and `last_accessed` feeds the decay factor
   in the ranking formula — so consecutive runs over the same corpus differ
   by roughly ±0.1 composite points. Any delta smaller than that is noise,
   and this document does not claim wins inside it.

## Current results (2026-07-17, corpus = 797 memories)

All three retrieval modes measured in one batch, same corpus, same golden set,
driven through the real MCP server. Embeddings: OpenAI
`text-embedding-3-small` (1024 dims) via the BYOK embedder.

| Metric | FTS-only | Vector-only | Hybrid (RRF) |
|--------|---------:|------------:|-------------:|
| **Composite L2 score** | 88.9 | 89.2 | **91.7** |
| Recall@5 | 0.907 | 0.898 | **0.919** |
| MRR | 0.817 | 0.832 | **0.878** |
| nDCG@5 | 0.816 | 0.828 | **0.869** |
| Negative precision | 1.000 | 1.000 | 1.000 |
| Eval wall-time | 0.5 s | 27 s | 28 s |

This is the ablation that justifies the fusion design ([ADR-0002](adr/0002-hybrid-retrieval-rrf.md)):
**hybrid beats both legs individually, not just the weaker one.** The two legs
fail differently — lexical search has the better raw recall, vector search the
better ranking — and RRF keeps both properties instead of averaging them away.
Had hybrid merely landed between the two, the extra write-path complexity and
the API-key dependency would not have been worth it.

The wall-time column is the honest cost: vector and hybrid pay ~50× the
latency of FTS on this corpus, almost entirely in embedding API round-trips.
That is why FTS remains the zero-config default.

## History — the score is a trajectory, not a number

| Date | Corpus | Hybrid score | What changed |
|------|-------:|-------------:|--------------|
| 2026-03-10 | ~270 | 36.9 (FTS) | baseline; 21/50 cases blocked by import scope |
| 2026-03-17 | ~550 | 92.6 | import scope widened; hybrid RRF landed; BM25 inversion fix (+9 pts) |
| 2026-06-10 | 797 | 90.3 | corpus +42% after bulk imports — recency boost flooded top-K (open bug, see below) |
| 2026-07-17 | 797 | **91.7** | ranking fixes: BM25 field-weight shift, double importance boost, date-query routing |

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

- **FAC-011** (all modes): a lookup labeled *easy* — "how many books has N
  read, and how many have personal notes" — whose answer sits in one file's
  frontmatter. It scored recall 1.0 until the corpus grew ~40%, then dropped
  to 0.0. This is not a hard-query problem, it is the recency bug below
  eating a weak-match query. It stays on the failure list until that fix
  lands, precisely because a plausible "top-K can't do aggregation" excuse
  would have retired a real, tracked defect.
- **Recency boost keys off the wrong timestamp** (open, and the cause of the
  92.6 → 90.3 drop above). It ranks by `created_at`, which is the row's
  insert time — so a bulk re-import makes the entire corpus look brand new at
  once and floods weak-match queries. The fix is to rank by when the thing
  *happened* (`event_at`, or the source file's modification time), not when
  the row was written. Not yet done; the golden set will be re-run against it.
- **2 hybrid soft regressions** (XRF family): when a lexical match is very
  strong, vector neighbors dilute it through RRF and demote the correct hit
  by a few positions. Net hybrid effect stays positive; candidates for
  fusion-weight tuning.

## What this eval does not cover

Stated so the numbers are not read as broader than they are:

- **Filtered retrieval.** Golden-set queries are mostly unfiltered, so they
  barely exercise the layer/entity/scope filter paths. A KNN candidate-pool
  bug that returned false negatives on filtered vector queries was found by
  audit and fixed with a targeted regression test — the golden set never
  moved, before or after. Coverage gaps do not show up as score drops; that
  is exactly why the score is not the only gate.
- **Scale.** 797 memories is a personal corpus. Nothing here says how ranking
  behaves at 100k.
- **Concurrency and multi-client behavior** — see the limitations in
  [ARCHITECTURE.md](ARCHITECTURE.md).

## Reproducing

The harness lives in the private KB repo (`eval/scripts/run_eval.py`,
`--step 2` for retrieval). Against your own corpus:

```bash
python eval/scripts/step2_retrieval.py --mode mcp --mcp-mode hybrid --json
```

It spawns `mnemon-mcp/dist/index.js`, so whatever you measure is what ships.
