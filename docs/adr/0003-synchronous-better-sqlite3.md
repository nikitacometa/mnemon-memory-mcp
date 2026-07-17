# ADR-0003: Synchronous better-sqlite3 over async drivers

**Status:** Accepted
**Date:** 2026-03-05 (documented retroactively 2026-07-17)

## Context

Node SQLite bindings come in two flavors: async (node-sqlite3, worker-pool
based) and sync (better-sqlite3). Conventional Node wisdom says "never block
the event loop", which pushes toward async by default.

## Decision

Use **better-sqlite3 (synchronous)** for all database access.

The MCP stdio transport processes one JSON-RPC request at a time off stdin.
There is no concurrent request stream inside a single server process — the
event loop has nothing else useful to do while a query runs. Our hottest
query (FTS search) measures in fractions of a millisecond; a worker-pool
round-trip costs more than the query itself.

Synchronous access also buys correctness for free:

- `db.transaction(() => { ... })` composes multi-statement invariants
  (supersede chain rewiring, event-log writes) without async interleaving —a
  whole class of TOCTOU bugs cannot exist inside a transaction body.
- No connection pool, no promise chains in tool handlers, stack traces point
  at the actual call site.

## Consequences

- Tool handlers are plain functions — easy to test against an in-memory DB
  (the whole 260+ test suite runs in ~1.5 s).
- The HTTP transport (multi-client) inherits a **single-writer assumption**:
  two server processes sharing one DB file get WAL-level safety from SQLite
  (busy_timeout = 5000), but application-level chain-rewiring invariants are
  not defended against cross-process races. This is documented as a known
  limitation in [ARCHITECTURE.md](../ARCHITECTURE.md) — the intended
  deployment is one server process per database file.
- A pathological query would block the process. Accepted: queries are bounded
  by validation (max lengths, LIMIT caps) and the corpus is personal-scale.
