# Contributing to mnemon-mcp

## Philosophy

**Air-gapped by default.** No telemetry, no analytics, no crash reporting, no pings to any external service — ever. All data stays on the user's machine in `~/.mnemon-mcp/memory.db`.

The single exception is the **optional** embedder (`src/embedder.ts`): when the user explicitly configures `MNEMON_EMBEDDING_PROVIDER`, it calls the provider they chose — their own OpenAI key, or a local Ollama. Nothing else may reach the network, and vector search must always degrade cleanly to FTS when no embedder is configured.

PRs adding telemetry, analytics, or any network call outside that opt-in path will be rejected without review.

## Development Setup

```bash
git clone https://github.com/nikitacometa/mnemon-memory-mcp.git
cd mnemon-memory-mcp
npm install
npm run build
npm test
```

Requires Node.js 20+ and TypeScript 5.9. CI tests against Node 20 and 22.

## Running Locally

```bash
npm run dev
```

Smoke test — verify the server responds to JSON-RPC over stdio:

```bash
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js
```

## Code Guidelines

- **TypeScript strict mode** — no `any`, no unsafe casts, return types on all exported functions.
- **Never use `console.log()` in `src/tools/` or `src/import/`** — stdout is the MCP JSON-RPC transport. Any stray output will corrupt the protocol. Use `console.error()` for debugging.
- **Run `npm run build`, `npm run lint`, and `npm test` before opening a PR.** All three must pass — CI runs the same three on Node 20 and 22.
- **Keep dependencies minimal.** Before adding a package, consider whether the standard library or an existing dep covers the use case.
- **No `any`** — prefer `unknown` with a type guard, or a generic with a constraint.

## PR Guidelines

- One feature per PR. Split unrelated changes into separate PRs.
- Include tests for all new functionality. The test runner is Vitest (`npm test`).
- Update `README.md` if adding new MCP tools or changing observable behavior.
- **Changes to ranking or retrieval must come with numbers.** State what moved on a golden set and what regressed — see [docs/EVALUATION.md](docs/EVALUATION.md) for the methodology. "Feels better" is not a measurement.

## Security Policy

- Never include memory content in error messages or log output. Tool errors are sanitized before reaching the client — filesystem paths must not leak (see `src/server.ts`).
- Sanitize all user-supplied strings before embedding them in error responses.
- No network calls outside the opt-in embedder path — not in tools, not in the import pipeline, not in tests.
- Report security issues privately via GitHub Security Advisories, not in public issues.

## Architecture Notes

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map and
the write/read paths. The decisions behind them are recorded as [ADRs](docs/adr/)
— read the relevant one before proposing a change that reverses it:

- `better-sqlite3` is synchronous **on purpose** ([ADR-0003](docs/adr/0003-synchronous-better-sqlite3.md)) — the stdio transport handles one request at a time, and sync access is what makes multi-statement invariants composable. Do not replace it with an async driver.
- Embeddings are optional **on purpose** ([ADR-0001](docs/adr/0001-sqlite-fts5-over-vector-db.md), [ADR-0002](docs/adr/0002-hybrid-retrieval-rrf.md)). FTS5 must remain a complete, working default.
- FTS5 search lives in `src/tools/memory-search.ts`. The tokenizer is `unicode61` (Cyrillic + Latin). Stemming improvements belong in the pre-processing layer, not in the tokenizer config.
