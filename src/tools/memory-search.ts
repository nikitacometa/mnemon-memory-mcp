/**
 * memory_search — FTS5-backed search with layer/entity/date/scope filtering.
 *
 * Default mode: 'fts' — tokenize query into words, build FTS5 AND query.
 * Scores via FTS5 bm25(), normalized to 0–1 range.
 * Superseded entries excluded unless include_superseded=true.
 *
 * Search modes:
 *   fts    — FTS5 tokenized search (default)
 *   exact  — LIKE substring match, fixed score 1.0
 */

import type Database from "better-sqlite3";
import type {
  EntityType,
  Layer,
  MemorySearchInput,
  MemorySearchOutput,
  MemorySearchResult,
} from "../types.js";
import type { Embedder } from "../embedder.js";
import { isStopWord } from "../stop-words.js";
import { stemWord } from "../stemmer.js";
import { knnSearch, isVecLoaded } from "../vector.js";
import { extractDatesFromQuery } from "../date-extractor.js";

const DEFAULT_LIMIT = 10;
const SNIPPET_TOKENS = 64;

/** Resolve entity alias to canonical name. Returns the input if no alias exists. */
function resolveEntityName(db: Database.Database, name: string): string {
  const row = db.prepare<[string], { canonical: string }>(
    `SELECT canonical FROM entity_aliases WHERE alias = ?`
  ).get(name);
  return row ? row.canonical : name;
}

/** Escape FTS5 special characters and trailing punctuation to prevent syntax errors */
function escapeFtsToken(token: string): string {
  // Remove FTS5 query syntax chars + general punctuation from natural language queries
  // Note: hyphens (-) NOT stripped — unicode61 tokenizer uses them as separators
  return token
    .replace(/["'^*():?!.,;—–\/]/g, "")
    .replace(/ё/g, "е")
    .replace(/Ё/g, "Е")
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, "");
}

/**
 * Build FTS5 MATCH query from user query string.
 * 1. Splits on whitespace
 * 2. Removes stop words (Russian + English) to avoid over-restrictive AND queries
 * 3. Escapes FTS5 special chars
 * 4. Applies prefix matching for tokens ≥ 4 chars (morphological variants)
 *
 * If ALL tokens are stop words, falls back to using original tokens
 * (graceful degradation — better to search with stop words than return nothing).
 */
/** Bilingual month mapping for cross-language query expansion */
const MONTH_CROSS: Record<string, string> = {
  // Russian → English
  январ: "januari", феврал: "februari", март: "march",
  апрел: "april", июн: "june", июл: "juli",
  август: "august", сентябр: "septemb", октябр: "octob",
  ноябр: "novemb", декабр: "decemb",
  // English → Russian
  januari: "январ", februari: "феврал", march: "март",
  april: "апрел", june: "июн", juli: "июл",
  august: "август", septemb: "сентябр", octob: "октябр",
  novemb: "ноябр", decemb: "декабр",
};

/** Convert a single token into an FTS5 prefix term: escape, stem, quote.
 * Month names are expanded to bilingual OR groups for cross-language matching. */
function tokenToFts(token: string): string {
  const escaped = escapeFtsToken(token);
  if (!escaped) return "";
  const stemmed = stemWord(escaped);
  const stem = stemmed.length < escaped.length ? stemmed : escaped;

  let primary: string;
  if (stem.length >= 2) primary = `"${stem}"*`;
  else if (escaped.length >= 2) primary = `"${escaped}"*`;
  else primary = `"${escaped}"`;

  // Cross-language month expansion: "март"* → ("март"* OR "march"*)
  const crossMonth = MONTH_CROSS[stem];
  if (crossMonth) {
    return `(${primary} OR "${crossMonth}"*)`;
  }

  return primary;
}

function buildFtsQuery(query: string, operator: "AND" | "OR" = "AND"): string {
  // Split on whitespace, em/en-dash, AND hyphens (FTS5 unicode61 tokenizes hyphens as separators,
  // so "рэп-архив" must become separate tokens to match the stemmed index)
  const rawTokens = query
    .trim()
    .split(/[\s\u2013\u2014\u2015—–\-]+/)
    .filter((t) => t.length > 0);

  // Filter stop words. Strip trailing punctuation before lookup so "Никиты?" → "никиты"
  const normalizeForStopword = (t: string): string =>
    t.replace(/[?!.,;:—–\u2014\u2013]+$/, "").toLowerCase();
  const contentTokens = rawTokens.filter((t) => {
    const norm = normalizeForStopword(t);
    if (isStopWord(norm)) return false;
    if (norm.length <= 1) return false;
    if (/^\d{1,2}$/.test(norm)) return false;
    return true;
  });
  const effectiveTokens = contentTokens.length > 0 ? contentTokens : rawTokens;

  const ftsTokens = effectiveTokens
    .map(tokenToFts)
    .filter((t) => t !== "" && t !== '""');

  if (ftsTokens.length === 0) {
    throw new Error("Query must contain at least one non-empty term");
  }

  return ftsTokens.join(` ${operator} `);
}

/** Normalize BM25 score (negative rank) to 0–1, preserving relevance order.
 * BM25 returns negative values where more negative = more relevant.
 * |rank|/(1+|rank|) maps to (0,1) and keeps the correct ordering. */
function normalizeBm25(rank: number): number {
  const abs = Math.abs(rank);
  return abs / (1 + abs);
}

/**
 * Ebbinghaus decay — layer-specific half-lives.
 * Semantic and procedural memories do NOT decay (facts and rules don't "forget").
 * Episodic decays at 30-day half-life, resource at 90 days.
 */
const DECAY_HALF_LIFE_DAYS: Record<Layer, number | null> = {
  episodic: 30,
  resource: 90,
  semantic: null,
  procedural: null,
};

function decayFactor(layer: Layer, referenceDate: string): number {
  const halfLife = DECAY_HALF_LIFE_DAYS[layer];
  if (halfLife === null) return 1.0;
  const daysSince = (Date.now() - new Date(referenceDate).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 0) return 1.0;
  return Math.exp(-Math.LN2 * daysSince / halfLife);
}

/**
 * Recency boost — mild signal favoring newer memories.
 * Returns 1.0 for memories created today, ~0.73 at 1 year, ~0.58 at 3 years.
 * Applied to all layers equally.
 */
function recencyBoost(createdAt: string): number {
  const daysSince = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 0) return 1.0;
  return 1 / (1 + daysSince / 365);
}

/**
 * Generate a snippet centered on matched query terms from original content.
 * Falls back to the first SNIPPET_TOKENS words if no terms found.
 */
function makeSnippet(content: string, queryTerms?: string[]): string {
  const words = content.split(/\s+/);
  if (words.length <= SNIPPET_TOKENS) return content;

  // Try to center snippet around first occurrence of a query term (raw or stemmed)
  if (queryTerms && queryTerms.length > 0) {
    const lowerWords = words.map((w) => w.toLowerCase());
    // Build search terms: both raw and stemmed forms for snippet centering
    const searchTerms: string[] = [];
    for (const term of queryTerms) {
      const lower = term.toLowerCase();
      searchTerms.push(lower);
      const stemmed = stemWord(lower);
      if (stemmed !== lower && stemmed.length >= 2) {
        searchTerms.push(stemmed);
      }
    }
    let bestIdx = -1;
    for (const term of searchTerms) {
      const idx = lowerWords.findIndex((w) => w.includes(term));
      if (idx !== -1) {
        bestIdx = idx;
        break;
      }
    }

    if (bestIdx !== -1) {
      const half = Math.floor(SNIPPET_TOKENS / 2);
      const start = Math.max(0, bestIdx - half);
      const end = Math.min(words.length, start + SNIPPET_TOKENS);
      const prefix = start > 0 ? "…" : "";
      const suffix = end < words.length ? "…" : "";
      return prefix + words.slice(start, end).join(" ") + suffix;
    }
  }

  return words.slice(0, SNIPPET_TOKENS).join(" ") + "…";
}

interface FtsRow {
  id: string;
  rank: number;
}

interface MemoryBaseRow {
  id: string;
  layer: string;
  title: string | null;
  content: string;
  entity_type: string | null;
  entity_name: string | null;
  confidence: number;
  importance: number;
  scope: string;
  source_file: string | null;
  created_at: string;
  event_at: string | null;
  last_accessed: string | null;
  superseded_by: string | null;
}

export async function memorySearch(
  db: Database.Database,
  input: MemorySearchInput,
  embedder?: Embedder | null
): Promise<MemorySearchOutput> {
  const startMs = Date.now();
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  // Auto-select hybrid mode when embedder is available and user didn't specify mode.
  // Hybrid (RRF of FTS5 + vector) consistently outperforms FTS-only on golden set.
  const mode = input.mode ?? (embedder && isVecLoaded() ? "hybrid" : "fts");

  // Auto-extract dates from query for temporal routing.
  // Only applies when caller has not supplied explicit date filters.
  const extracted = extractDatesFromQuery(input.query);
  if (extracted.date_from && !input.date_from) {
    input = { ...input, date_from: extracted.date_from };
  }
  if (extracted.date_to && !input.date_to) {
    input = { ...input, date_to: extracted.date_to };
  }
  // Use cleaned query (dates stripped) for FTS matching. An empty cleaned
  // query is meaningful: it routes to pure date-range search below — falling
  // back to the original query here would FTS-match the date words themselves
  if (extracted.date_from || extracted.date_to) {
    input = { ...input, query: extracted.cleanedQuery };
  }

  let ids: Array<{ id: string; score: number }>;

  // Over-fetch from SQL to account for JS re-ranking (decay/importance can reorder results).
  // Without over-fetch, pagination can show wrong items when JS sort differs from SQL sort.
  // +1 enables has_more detection without a separate COUNT query.
  const fetchLimit = offset > 0 ? (limit + offset) * 3 : limit + 1;

  // Detect whether the remaining query is semantically empty (all stop words / short tokens).
  // If so, pure date-range search is more accurate than FTS5 over stripped tokens.
  const isQueryEmpty = !input.query.trim() ||
    input.query.trim()
      .split(/[\s\u2013\u2014\u2015—–\-]+/)
      .every((t) => {
        const norm = t.replace(/[?!.,;:—–\u2014\u2013]+$/, "").toLowerCase();
        return !norm || norm.length <= 1 || isStopWord(norm) || /^\d{1,2}$/.test(norm);
      });

  if (isQueryEmpty && (input.date_from || input.date_to)) {
    ids = dateRangeSearch(db, input, fetchLimit);
  } else if (mode === "vector") {
    if (!embedder) {
      throw new Error("Vector search requires an embedding provider. Set MNEMON_EMBEDDING_PROVIDER env var.");
    }
    if (!isVecLoaded()) {
      throw new Error("Vector search requires sqlite-vec. Install: npm install sqlite-vec");
    }
    ids = await vectorSearch(db, input, embedder, fetchLimit);
  } else if (mode === "hybrid") {
    if (!embedder) {
      throw new Error("Hybrid search requires an embedding provider. Set MNEMON_EMBEDDING_PROVIDER env var.");
    }
    if (!isVecLoaded()) {
      throw new Error("Hybrid search requires sqlite-vec. Install: npm install sqlite-vec");
    }
    ids = await hybridSearch(db, input, embedder, fetchLimit);
  } else if (mode === "exact") {
    ids = exactSearch(db, input, fetchLimit);
  } else {
    ids = ftsSearch(db, input, fetchLimit);
  }

  if (ids.length === 0) {
    const queryTimeMs = Date.now() - startMs;
    logSearch(db, input, mode, 0, [], queryTimeMs);
    return { memories: [], returned_count: 0, has_more: false, query_time_ms: queryTimeMs };
  }

  // Fetch full rows for matched IDs
  const idList = ids.map((r) => r.id);
  const placeholders = idList.map(() => "?").join(", ");

  const rows = db
    .prepare<string[], MemoryBaseRow>(
      `SELECT id, layer, title, content, entity_type, entity_name,
              confidence, importance, scope, source_file, created_at, event_at,
              last_accessed, superseded_by
       FROM memories
       WHERE id IN (${placeholders})`
    )
    .all(...idList);

  // Extract raw query terms for snippet highlighting
  const queryTerms = input.query
    .trim()
    .split(/[\s\u2013\u2014\u2015—–\-]+/)
    .filter((t) => t.length >= 2);

  // Map back scores, boost by importance, decay, and recency for ranking
  // Formula: final_score = bm25_score * importanceBoost * decay * recency
  // importanceBoost: 0.3–1.0 (wider range from importance field)
  // decay: episodic/resource decay over time, semantic/procedural = 1.0
  // recency: mild boost for newer memories (1.0 today → ~0.73 at 1yr)
  const scoreMap = new Map(ids.map((r) => [r.id, r.score]));

  const memories: MemorySearchResult[] = rows
    .map((row) => {
      const bm25Score = scoreMap.get(row.id) ?? 0;
      const importanceBoost = 0.3 + 0.7 * row.importance;
      const decay = decayFactor(row.layer as Layer, row.last_accessed ?? row.created_at);
      const recency = recencyBoost(row.created_at);
      return {
        id: row.id,
        layer: row.layer as Layer,
        title: row.title,
        content: row.content,
        snippet: makeSnippet(row.content, queryTerms),
        score: bm25Score * importanceBoost * decay * recency,
        entity_type: row.entity_type as EntityType | null,
        entity_name: row.entity_name,
        confidence: row.confidence,
        importance: row.importance,
        scope: row.scope,
        source_file: row.source_file,
        created_at: row.created_at,
        event_at: row.event_at,
      };
    })
    .sort((a, b) => b.score - a.score);

  const has_more = memories.length > offset + limit;
  const paged = memories.slice(offset, offset + limit);

  // Update access tracking for returned results
  if (paged.length > 0) {
    const updateIds = paged.map((m) => m.id);
    const ph = updateIds.map(() => "?").join(", ");
    db.prepare(
      `UPDATE memories SET access_count = access_count + 1,
              last_accessed = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id IN (${ph})`
    ).run(...updateIds);
  }

  const queryTimeMs = Date.now() - startMs;

  // Log search query for observability
  logSearch(db, input, mode, paged.length, paged.map((m) => m.id), queryTimeMs);

  return {
    memories: paged,
    returned_count: paged.length,
    has_more,
    query_time_ms: queryTimeMs,
  };
}

/**
 * Pure date-range search — used when the FTS query is empty after date extraction.
 * Returns memories within the date range sorted by importance desc, event_at desc.
 * Score uses the same importance boost formula as FTS search for consistent ranking.
 */
function dateRangeSearch(
  db: Database.Database,
  input: MemorySearchInput,
  limit: number
): Array<{ id: string; score: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!input.include_superseded) {
    conditions.push("superseded_by IS NULL");
  }
  conditions.push("(expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))");

  if (input.date_from) {
    conditions.push("date(COALESCE(event_at, created_at)) >= ?");
    params.push(input.date_from);
  }
  if (input.date_to) {
    conditions.push("date(COALESCE(event_at, created_at)) <= ?");
    params.push(input.date_to);
  }
  if (input.layers && input.layers.length > 0) {
    conditions.push(`layer IN (${input.layers.map(() => "?").join(", ")})`);
    params.push(...input.layers);
  }
  if (input.entity_name) {
    const resolved = resolveEntityName(db, input.entity_name);
    conditions.push("entity_name = ?");
    params.push(resolved);
  }
  if (input.scope) {
    conditions.push("scope = ?");
    params.push(input.scope);
  }
  if (input.min_confidence !== undefined) {
    conditions.push("confidence >= ?");
    params.push(input.min_confidence);
  }
  if (input.min_importance !== undefined) {
    conditions.push("importance >= ?");
    params.push(input.min_importance);
  }

  // Temporal fact windows: filter by as_of date (use datetime() for safe comparison)
  if (input.as_of) {
    conditions.push("(valid_from IS NULL OR datetime(valid_from) <= datetime(?))");
    conditions.push("(valid_until IS NULL OR datetime(valid_until) >= datetime(?))");
    params.push(input.as_of);
    params.push(input.as_of);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT id, importance
    FROM memories
    ${whereClause}
    ORDER BY importance DESC, event_at DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare<unknown[], { id: string; importance: number }>(sql).all(...params);
  // Neutral stand-in for the bm25 score — memorySearch multiplies in the
  // importance boost exactly once for every mode; doing it here too would
  // square the boost for pure date-range queries
  return rows.map((r) => ({
    id: r.id,
    score: 1.0,
  }));
}

function ftsSearch(
  db: Database.Database,
  input: MemorySearchInput,
  limit: number
): Array<{ id: string; score: number }> {
  let ftsQuery: string;
  try {
    ftsQuery = buildFtsQuery(input.query, "AND");
  } catch (err) {
    throw new Error(`Invalid search query: ${err instanceof Error ? err.message : String(err)}`);
  }

  const conditions: string[] = ["fts.id = m.id"];

  if (!input.include_superseded) {
    conditions.push("m.superseded_by IS NULL");
  }

  // Exclude expired memories
  conditions.push("(m.expires_at IS NULL OR m.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))");

  if (input.layers && input.layers.length > 0) {
    const placeholders = input.layers.map(() => "?").join(", ");
    conditions.push(`m.layer IN (${placeholders})`);
  }

  // Resolve entity alias to canonical name
  const resolvedEntity = input.entity_name ? resolveEntityName(db, input.entity_name) : undefined;

  if (resolvedEntity) {
    conditions.push("m.entity_name = ?");
  }

  if (input.scope) {
    conditions.push("m.scope = ?");
  }

  if (input.date_from) {
    conditions.push("date(COALESCE(m.event_at, m.created_at)) >= ?");
  }

  if (input.date_to) {
    conditions.push("date(COALESCE(m.event_at, m.created_at)) <= ?");
  }

  // Temporal fact windows: filter by as_of date (use datetime() for safe comparison)
  if (input.as_of) {
    conditions.push("(m.valid_from IS NULL OR datetime(m.valid_from) <= datetime(?))");
    conditions.push("(m.valid_until IS NULL OR datetime(m.valid_until) >= datetime(?))");
  }

  if (input.min_confidence !== undefined) {
    conditions.push("m.confidence >= ?");
  }

  if (input.min_importance !== undefined) {
    conditions.push("m.importance >= ?");
  }

  const whereClause =
    conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

  // Field weights for bm25(): title=3x, content=1x, entity_name=2x.
  // bm25() takes one weight per fts column IN TABLE ORDER, including the
  // UNINDEXED id column — its slot must be present (0.0) or every weight
  // shifts onto the wrong column
  const sql = `
    SELECT fts.id, bm25(memories_fts, 0.0, 3.0, 1.0, 2.0) AS rank
    FROM memories_fts fts
    JOIN memories m ON fts.id = m.id
    WHERE memories_fts MATCH ?
      ${whereClause}
    ORDER BY rank
    LIMIT ?
  `;

  // Build filter params separately from FTS query for clean OR-fallback reuse
  const filterParams: unknown[] = [];
  if (input.layers && input.layers.length > 0) {
    filterParams.push(...input.layers);
  }
  if (resolvedEntity) filterParams.push(resolvedEntity);
  if (input.scope) filterParams.push(input.scope);
  if (input.date_from) filterParams.push(input.date_from);
  if (input.date_to) filterParams.push(input.date_to);
  if (input.as_of) {
    filterParams.push(input.as_of);
    filterParams.push(input.as_of);
  }
  if (input.min_confidence !== undefined) filterParams.push(input.min_confidence);
  if (input.min_importance !== undefined) filterParams.push(input.min_importance);

  const runQuery = (matchExpr: string, penalty = 1.0): Array<{ id: string; score: number }> => {
    try {
      const p = [matchExpr, ...filterParams, limit];
      const rows = db.prepare<unknown[], FtsRow>(sql).all(...p);
      return rows.map((r) => ({ id: r.id, score: normalizeBm25(r.rank) * penalty }));
    } catch {
      return [];
    }
  };

  try {
    let results = runQuery(ftsQuery);

    // Progressive AND relaxation: when full AND with 3+ tokens returns too few results,
    // try AND with just the 2 longest (most specific) stems before falling back to OR.
    if (results.length < limit) {
      const contentTokens = ftsQuery.split(/ AND /);
      if (contentTokens.length >= 3) {
        // Sort by stem length descending (longer stems = more specific)
        const top2 = [...contentTokens].sort((a, b) => b.length - a.length).slice(0, 2);
        const relaxedQuery = top2.join(" AND ");
        const relaxedResults = runQuery(relaxedQuery, 0.9);
        const existingIds = new Set(results.map((r) => r.id));
        const newOnly = relaxedResults.filter((r) => !existingIds.has(r.id));
        results = [...results, ...newOnly];
      }
    }

    // Supplement with OR results when AND returns fewer than limit results.
    if (results.length < limit && input.query.trim().split(/[\s\-]+/).length > 1) {
      const orQuery = buildFtsQuery(input.query, "OR");
      const orResults = runQuery(orQuery, 0.8);
      const existingIds = new Set(results.map((r) => r.id));
      const orOnly = orResults.filter((r) => !existingIds.has(r.id));
      results = [...results, ...orOnly];
    }

    return results;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`FTS5 query failed: ${message}`);
  }
}

function exactSearch(
  db: Database.Database,
  input: MemorySearchInput,
  limit: number
): Array<{ id: string; score: number }> {
  const escaped = input.query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const conditions: string[] = ["content LIKE ? ESCAPE '\\'"];
  const params: unknown[] = [`%${escaped}%`];

  if (!input.include_superseded) {
    conditions.push("superseded_by IS NULL");
  }

  // Exclude expired memories
  conditions.push("(expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))");

  if (input.layers && input.layers.length > 0) {
    const placeholders = input.layers.map(() => "?").join(", ");
    conditions.push(`layer IN (${placeholders})`);
    params.push(...input.layers);
  }

  if (input.entity_name) {
    const resolvedEntity = resolveEntityName(db, input.entity_name);
    conditions.push("entity_name = ?");
    params.push(resolvedEntity);
  }

  if (input.scope) {
    conditions.push("scope = ?");
    params.push(input.scope);
  }

  if (input.date_from) {
    conditions.push("date(COALESCE(event_at, created_at)) >= ?");
    params.push(input.date_from);
  }

  if (input.date_to) {
    conditions.push("date(COALESCE(event_at, created_at)) <= ?");
    params.push(input.date_to);
  }

  // Temporal fact windows: filter by as_of date (use datetime() for safe comparison)
  if (input.as_of) {
    conditions.push("(valid_from IS NULL OR datetime(valid_from) <= datetime(?))");
    conditions.push("(valid_until IS NULL OR datetime(valid_until) >= datetime(?))");
    params.push(input.as_of);
    params.push(input.as_of);
  }

  if (input.min_confidence !== undefined) {
    conditions.push("confidence >= ?");
    params.push(input.min_confidence);
  }

  if (input.min_importance !== undefined) {
    conditions.push("importance >= ?");
    params.push(input.min_importance);
  }

  params.push(limit);

  const sql = `
    SELECT id FROM memories
    WHERE ${conditions.join(" AND ")}
    ORDER BY importance DESC, confidence DESC
    LIMIT ?
  `;

  const rows = db.prepare<unknown[], { id: string }>(sql).all(...params);
  // Exact match gets a fixed score of 1.0
  return rows.map((r) => ({ id: r.id, score: 1.0 }));
}

/**
 * Build SQL filter conditions from search input (shared by vector and hybrid).
 * Returns [conditions[], params[]] to add to a WHERE clause.
 */
function buildMemoryFilters(
  db: Database.Database,
  input: MemorySearchInput
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!input.include_superseded) {
    conditions.push("superseded_by IS NULL");
  }
  conditions.push("(expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))");

  if (input.layers && input.layers.length > 0) {
    conditions.push(`layer IN (${input.layers.map(() => "?").join(", ")})`);
    params.push(...input.layers);
  }
  if (input.entity_name) {
    const resolved = resolveEntityName(db, input.entity_name);
    conditions.push("entity_name = ?");
    params.push(resolved);
  }
  if (input.scope) {
    conditions.push("scope = ?");
    params.push(input.scope);
  }
  if (input.date_from) {
    conditions.push("date(COALESCE(event_at, created_at)) >= ?");
    params.push(input.date_from);
  }
  if (input.date_to) {
    conditions.push("date(COALESCE(event_at, created_at)) <= ?");
    params.push(input.date_to);
  }
  if (input.as_of) {
    conditions.push("(valid_from IS NULL OR datetime(valid_from) <= datetime(?))");
    conditions.push("(valid_until IS NULL OR datetime(valid_until) >= datetime(?))");
    params.push(input.as_of, input.as_of);
  }
  if (input.min_confidence !== undefined) {
    conditions.push("confidence >= ?");
    params.push(input.min_confidence);
  }
  if (input.min_importance !== undefined) {
    conditions.push("importance >= ?");
    params.push(input.min_importance);
  }

  return { conditions, params };
}

async function vectorSearch(
  db: Database.Database,
  input: MemorySearchInput,
  embedder: Embedder,
  limit: number
): Promise<Array<{ id: string; score: number }>> {
  const queryVec = await embedder.embed(input.query);
  // Over-fetch to account for filter losses
  const knnLimit = Math.min(limit * 3, 200);
  const results = knnSearch(db, queryVec, knnLimit, !input.include_superseded);

  if (results.length === 0) return [];

  // Apply the same filters as FTS/exact search
  const { conditions, params } = buildMemoryFilters(db, input);

  const knnIds = results.map((r) => r.memory_id);
  const idPlaceholders = knnIds.map(() => "?").join(", ");
  const allConditions = [`id IN (${idPlaceholders})`, ...conditions];

  const filtered = db
    .prepare<unknown[], { id: string }>(
      `SELECT id FROM memories WHERE ${allConditions.join(" AND ")}`
    )
    .all(...knnIds, ...params);

  const filteredSet = new Set(filtered.map((r) => r.id));

  return results
    .filter((r) => filteredSet.has(r.memory_id))
    .map((r) => ({ id: r.memory_id, score: Math.max(0, 1 - r.distance) }))
    .slice(0, limit);
}

/**
 * Extract quoted terms (single or double quotes) from query.
 * Returns { entities: quoted terms, remainder: query without quotes }.
 */
function extractQuotedEntities(query: string): { entities: string[]; remainder: string } {
  const entities: string[] = [];
  // Match quoted terms: ASCII quotes, Unicode smart quotes, guillemets.
  // \u2018\u2019 = left/right single, \u201C\u201D = left/right double,
  // \u00AB\u00BB = guillemets, plus ASCII ' and "
  const quoteChars = "'\"\u2018\u2019\u201C\u201D\u00AB\u00BB";
  const re = new RegExp(`[${quoteChars}]\\s*([^${quoteChars}]{2,}?)\\s*[${quoteChars}]`, "g");
  const cleaned = query.replace(re, (_match, inner: string) => {
    entities.push(inner.trim());
    return " ";
  });
  return { entities, remainder: cleaned.replace(/\s{2,}/g, " ").trim() };
}

async function hybridSearch(
  db: Database.Database,
  input: MemorySearchInput,
  embedder: Embedder,
  limit: number
): Promise<Array<{ id: string; score: number }>> {
  // Core search: FTS + vector on the original query
  const coreSearches: Array<Promise<Array<{ id: string; score: number }>>> = [
    Promise.resolve(ftsSearch(db, input, limit)),
    vectorSearch(db, input, embedder, limit),
  ];

  // Cross-reference expansion: when the query contains quoted entities,
  // run additional sub-queries to improve recall for multi-topic queries.
  // E.g. "Как книга 'Эссенциализм' вписывается в убеждения о работе"
  //   → entity sub-query: "Эссенциализм" (finds books.md)
  //   → topic sub-queries: "вписывается в убеждения о работе" (finds worldview.md)
  const { entities, remainder } = extractQuotedEntities(input.query);
  const entitySearches: Array<Promise<Array<{ id: string; score: number }>>> = [];
  const topicSearches: Array<Promise<Array<{ id: string; score: number }>>> = [];

  if (entities.length > 0) {
    for (const entity of entities) {
      // Both FTS and vector for entity — FTS catches exact terms, vector captures semantics
      entitySearches.push(
        Promise.resolve(ftsSearch(db, { ...input, query: entity }, limit))
      );
      entitySearches.push(vectorSearch(db, { ...input, query: entity }, embedder, limit));
    }
    if (remainder.length > 3) {
      topicSearches.push(
        Promise.resolve(ftsSearch(db, { ...input, query: remainder }, limit))
      );
      topicSearches.push(vectorSearch(db, { ...input, query: remainder }, embedder, limit));
    }
  }

  const [coreResults, entityResults, topicResults] = await Promise.all([
    Promise.all(coreSearches),
    Promise.all(entitySearches),
    Promise.all(topicSearches),
  ]);

  // Weighted RRF fusion: entity sub-queries get higher weight (3x) because
  // the user explicitly quoted these entities, signaling strong intent.
  // Core and topic sub-queries get standard weight (1x).
  const RRF_K = 60;
  const ENTITY_WEIGHT = 3.0;
  const scores = new Map<string, number>();

  const addRrf = (resultSet: Array<{ id: string; score: number }>, weight: number) => {
    resultSet.forEach((r, i) => {
      const rank = i + 1;
      scores.set(r.id, (scores.get(r.id) ?? 0) + weight / (RRF_K + rank));
    });
  };

  // Adaptive FTS weight: upweight FTS when it returns strong results (≥ limit matches).
  // This prevents vector noise from diluting high-quality FTS rankings.
  const ftsResults = coreResults[0] ?? [];
  const vecResults = coreResults[1] ?? [];
  const ftsWeight = ftsResults.length >= limit ? 1.5 : 1.0;
  addRrf(ftsResults, ftsWeight);
  addRrf(vecResults, 1.0);
  for (const resultSet of entityResults) addRrf(resultSet, ENTITY_WEIGHT);
  for (const resultSet of topicResults) addRrf(resultSet, 1.0);

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Log search query to search_log table for observability. Best-effort, never throws. */
function logSearch(
  db: Database.Database,
  input: MemorySearchInput,
  resolvedMode: string,
  resultCount: number,
  resultIds: string[],
  queryTimeMs: number
): void {
  try {
    const filters: Record<string, unknown> = {};
    if (input.layers) filters.layers = input.layers;
    if (input.entity_name) filters.entity_name = input.entity_name;
    if (input.scope) filters.scope = input.scope;
    if (input.date_from) filters.date_from = input.date_from;
    if (input.date_to) filters.date_to = input.date_to;
    if (input.as_of) filters.as_of = input.as_of;
    if (input.min_confidence !== undefined) filters.min_confidence = input.min_confidence;
    if (input.min_importance !== undefined) filters.min_importance = input.min_importance;

    db.prepare(
      `INSERT INTO search_log (query, mode, filters, result_count, result_ids, query_time_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      input.query,
      resolvedMode,
      JSON.stringify(filters),
      resultCount,
      JSON.stringify(resultIds.slice(0, 20)),
      queryTimeMs
    );

    // Prune entries older than 90 days (best-effort, ~1% of calls)
    if (Math.random() < 0.01) {
      db.prepare(
        `DELETE FROM search_log WHERE occurred_at < datetime('now', '-90 days')`
      ).run();
    }
  } catch {
    // Best-effort logging — never fail a search because of log write
  }
}

