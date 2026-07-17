# ADR-0002: Hybrid retrieval via Reciprocal Rank Fusion

**Status:** Accepted
**Date:** 2026-03-17 (documented retroactively 2026-07-17)

## Decision drivers

FTS5 alone scored 87.8/100 on the L2 retrieval golden set (see
[EVALUATION.md](../EVALUATION.md)). Its failures clustered on semantic
associations and cross-reference queries — cases where the query vocabulary
does not overlap the memory text at all. That is exactly what embeddings fix,
but ADR-0001 forbids making them mandatory.

## Decision

Add an **optional** vector index (sqlite-vec, BYOK embeddings via OpenAI or
Ollama) and fuse it with FTS5 using **weighted Reciprocal Rank Fusion**:

```
RRF(d) = Σ_source  w_source / (k + rank_source(d)),   k = 60
```

- `k = 60` follows the original RRF recommendation (Cormack et al., 2009);
  we did not re-tune it — the win over FTS-only was already decisive, and a
  per-corpus sweep would overfit a 48-case golden set.
- **Adaptive FTS weight:** when the FTS result list is strong (enough
  candidates), FTS gets weight 1.5 vs vector 1.0 — lexical hits on a personal
  KB are precise and should not be diluted by approximate neighbors.
- **Quoted-entity sub-queries:** a query like `книга 'Эссенциализм'` spawns a
  weighted (3×) sub-query for the quoted entity, which fixes cross-reference
  retrieval where the entity name is the whole signal.
- Hybrid auto-enables only when an embedder is configured and sqlite-vec
  loads; otherwise the server silently stays FTS-only. Same search API.

## Why RRF and not score fusion

BM25 scores and cosine similarities live on incomparable scales. Score
normalization (min-max, z-score) needs corpus statistics that shift with
every import, making ranking unstable. RRF only consumes **ranks**, is
scale-free, needs no calibration, and is trivially explainable — important
for the deterministic-ranking constraint from ADR-0001.

## Measured consequences

Same corpus (797 memories), same golden set, same day (2026-07-17):

| Mode | L2 score | Recall@5 | MRR | nDCG@5 |
|------|----------|----------|-----|--------|
| FTS-only | 88.9 | 0.907 | 0.817 | 0.816 |
| Hybrid RRF | **91.8** | **0.919** | **0.882** | **0.867** |

Known trade-off, tracked rather than hidden: on 2 golden cases with a very
strong lexical match, vector noise dilutes the FTS signal through the fusion
and slightly demotes the correct hit. Net effect is still positive; the
per-case regressions are documented in EVALUATION.md.

## Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Mandatory embeddings, vector-first | Breaks zero-cloud/zero-key install (ADR-0001) |
| Linear score blending (α·bm25 + β·cos) | Needs per-corpus calibration; unstable under imports |
| Learned reranker (cross-encoder) | Model download + inference latency in a local stdio server |
| LLM-as-reranker | Non-deterministic, slow, costs tokens on every search |
