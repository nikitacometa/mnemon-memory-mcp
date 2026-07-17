# MCP Memory Servers — Competitive Analysis

**Date:** 2026-03-13
**Purpose:** Positioning mnemon-mcp for OSS release

---

## Ecosystem Context

| Metric | Value | Source |
|--------|-------|--------|
| Total MCP servers | ~1,860–2,880 | PulseMCP / Smithery |
| GitHub repos with MCP | ~20,000 | Astrix Q1 2026 |
| Memory-focused servers | ~100+ | PulseMCP |
| Top server by views | Context7 (11K views/week) | FastMCP |

Memory is one of the most competitive MCP categories. No single server dominates the privacy-first / local-first structured memory niche.

---

## Direct Competitors

### 1. mem0ai/mem0-mcp

**GitHub:** 630 stars, 135 forks
**Stack:** Python, Qdrant + Neo4j + Ollama (cloud or self-hosted)
**License:** Apache 2.0

**Pricing:**
- Free: 10K memories/mo, 1K retrievals/mo
- Starter: $19/mo (50K memories)
- Pro: $249/mo (unlimited + graph memory + analytics)
- Enterprise: custom (on-prem, SSO, SOC 2/HIPAA)

**Strengths:** Mature ecosystem, Python/JS SDK, 80% token savings via compression, graph memory (Pro+), benchmarks vs OpenAI (+26% accuracy, −91% latency).

**User complaints (HN thread):**
- Privacy: data goes to US cloud, no GDPR compliance
- Graph memory behind $249/mo paywall
- Relevancy scoring opaque and unreliable
- Exclusion prompts unreliable for PII protection
- Unpredictable pricing, hard to model real costs
- Risk of OSS version becoming second-class citizen

### 2. basicmachines-co/basic-memory

**GitHub:** 2,600 stars, 174 forks
**Stack:** Python 3.12+, FastEmbed, FastMCP 3.0
**License:** AGPL v3

**Pricing:** Free locally, paid subscription for cloud sync.

**Strengths:** Obsidian-compatible Markdown files, hybrid search (FTS + vector), schema validation, human-readable format.

**Weaknesses:**
- Critical incident: FastMCP v2.10.0 broke JSON-RPC via stdout output
- AGPL blocks enterprise adoption
- Unstable upstream dependencies
- Per-project cloud routing opaque

### 3. Anthropic Knowledge Graph Memory (reference implementation)

**GitHub:** 80,900 stars (entire monorepo)
**Stack:** TypeScript, zero external dependencies
**License:** MIT

**Strengths:** Official reference implementation, maximally simple, built into Claude Desktop.

**Limitations:** No FTS, no vector search, no fact versioning, no layers — reference implementation, not production-ready. Flat JSON storage, doesn't scale.

### 4. getzep/graphiti (Zep Knowledge Graph MCP)

**GitHub:** 23,700 stars, 2,300 forks
**Stack:** Python 3.10+, Neo4j/FalkorDB/Kuzu
**License:** Apache 2.0

**Strengths:** Temporal knowledge graph with validity windows, change tracking over time, hybrid retrieval (BM25 + embeddings + graph traversal).

**Limitations:** Heavy infrastructure (Neo4j + LLM for graph extraction), not zero-cloud, complex onboarding.

### 5. Other Notable Players

| Server | Stars | Architecture | Differentiator |
|--------|-------|-------------|----------------|
| doobidoo/mcp-memory-service | ~500 | KG + ChromaDB (vector) | Multi-agent, D3.js visualization |
| coleam00/mcp-mem0 | ~400 | Mem0 wrapper | Template for customization |
| CaviraOSS/OpenMemory | ~300 | Local Mem0 | Migration from Zep/Mem0/Supermemory |
| Memento (@iAchilles) | n/a | SQLite FTS5 + sqlite-vec | Closest architectural analog |
| pinkpixel-dev/mem0-mcp | ~200 | Mem0 managed | Drop-in MCP wrapper |

---

## Architecture Comparison

| Approach | Examples | Pros | Cons |
|----------|----------|------|------|
| **Cloud managed API** | mem0, Zep cloud | Ready infra, analytics | GDPR, vendor lock-in, $249+/mo |
| **Vector DB (local)** | mcp-memory-service | Semantic search | Needs embedding model, RAM, slow cold start |
| **Knowledge graph** | Graphiti, Anthropic KG | Entity relationships | Neo4j/FalkorDB dependency, complex setup |
| **Markdown + vector** | basic-memory | Readable files, Obsidian-compatible | AGPL, unstable upstream, no versioning |
| **FTS5 SQLite** | mnemon-mcp | Zero deps, <1ms, Cyrillic | No semantics without vectors |
| **FTS5 + sqlite-vec** | Memento, ZeroClaw | Balance of precision and speed | Needs embedding model |

**Trend 2025–2026:** Hybrid search (FTS5 + vectors). FTS5 excels at exact terms/facts; vectors excel at semantic associations.

---

## What Users Actually Need

Based on HN discussions, Reddit, and review articles:

1. **Privacy-first** — unwillingness to send personal data to US cloud (especially EU/RU users)
2. **Zero dependencies** — install and forget, no Neo4j, no Qdrant, no Ollama
3. **Facts don't get lost or stale** — versioning, superseding chains
4. **Works in any language** — Cyrillic/CJK breaks unicode61 without stemmer
5. **Memory structure** — not just key-value, but meaningful layers (where it came from, how fresh it is)
6. **Predictable costs** — mem0 Pro $249/mo is a barrier for indie developers

---

## Feature Comparison Matrix

| Feature | mem0 | basic-memory | Graphiti | Anthropic KG | **mnemon-mcp** |
|---------|------|-------------|----------|--------------|----------------|
| Zero cloud | partial | yes | no | yes | **yes** |
| Zero external deps | no | no | no | yes | **yes** |
| 4 memory layers | no | no | no | no | **yes** |
| Superseding chains | partial | no | yes (temporal) | no | **yes** |
| Cyrillic morphology | no | no | no | no | **yes** |
| TypeScript | no (Python) | no (Python) | no (Python) | yes | **yes** |
| License | Apache 2.0 | **AGPL** | Apache 2.0 | MIT | **MIT** |
| Pricing | $19–249/mo | free+SaaS | free+SaaS | free | **free** |

---

## Positioning

### Strong Position
- Developers with privacy requirements (EU, personal agents)
- Russian-speaking users — only MCP memory server with Snowball stemmer for RU
- Indie devs and researchers: MIT, zero deps, SQLite — minimal friction
- Claude Desktop / Cursor users who need more structured memory than Anthropic KG

### Weak Position (don't compete)
- Enterprise with compliance (SOC 2, HIPAA) → mem0 Enterprise
- Entity relationship graphs → Graphiti
- Obsidian integration → basic-memory

### Messaging

**Main thesis:** "Persistent layered memory for AI agents — local-first, zero-cloud, no dependencies."

- vs mem0: "No $249/month. No GDPR risk. Runs in one SQLite file."
- vs basic-memory: "MIT license (not AGPL). TypeScript (not Python). Structured 4-layer model."
- vs Anthropic KG: "FTS5 search, fact versioning, import pipeline — production-ready, not a reference implementation."
- Unique claim: "The only MCP memory server with Russian morphological analysis."

---

## Product Roadmap Recommendations

1. **sqlite-vec integration** — adds semantic search without external dependencies. Precedent: Memento and ZeroClaw already do this. Moves mnemon-mcp from "FTS only" to full hybrid.
2. **Temporal facts** — validity windows (like Graphiti, but without Neo4j). Superseding chains already partially implement this.
3. **Registry listing** — Smithery/mcp.so/PulseMCP. Context7 gets 11K views/week from registry visibility alone.
4. **README positioning** — explicit privacy/GDPR story, price comparison with mem0, TypeScript vs Python (npm install vs pip + qdrant + neo4j).

---

## Sources

- [mem0ai/mem0-mcp GitHub](https://github.com/mem0ai/mem0-mcp)
- [basicmachines-co/basic-memory GitHub](https://github.com/basicmachines-co/basic-memory)
- [getzep/graphiti GitHub](https://github.com/getzep/graphiti)
- [Anthropic Knowledge Graph Memory MCP — PulseMCP](https://www.pulsemcp.com/servers/modelcontextprotocol-knowledge-graph-memory)
- [Mem0 vs Zep vs LangMem vs MemoClaw — DEV Community](https://dev.to/anajuliabit/mem0-vs-zep-vs-langmem-vs-memoclaw-ai-agent-memory-comparison-2026-1l1k)
- [Show HN: Mem0 — user criticisms thread](https://news.ycombinator.com/item?id=41447317)
- [AI Memory Systems Benchmark](https://guptadeepak.com/the-ai-memory-wars-why-one-system-crushed-the-competition-and-its-not-openai/)
- [Top 10 MCP Servers 2026 — FastMCP](https://fastmcp.me/blog/top-10-most-popular-mcp-servers)
- [State of AI Assets Q1 2026](https://dev.to/zarq-ai/state-of-ai-assets-q1-2026-143k-agents-17k-mcp-servers-all-trust-scored-2dc2)
- [Graphiti MCP 1.0 release](https://blog.getzep.com/graphiti-hits-20k-stars-mcp-server-1-0/)
- [ZeroClaw Hybrid Memory](https://zeroclaws.io/blog/zeroclaw-hybrid-memory-sqlite-vector-fts5/)
- [Mem0 pricing](https://mem0.ai/pricing)
