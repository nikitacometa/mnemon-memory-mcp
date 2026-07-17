# Contributing to mnemon-mcp

## Philosophy

**Air-gapped by design.** mnemon-mcp makes zero network calls. No telemetry, no analytics, no crash reporting, no pings to any external service. All data stays on the user's machine in `~/.mnemon-mcp/memory.db`.

PRs adding telemetry, analytics, or any external network call will be rejected without review.

## Development Setup

```bash
git clone https://github.com/nikitacometa/mnemon-memory-mcp.git
cd mnemon-memory-mcp
npm install
npm run build
npm test
```

Requires Node.js 22+ and TypeScript 5.9.

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
- **Run `npm test` and `npm run build` before opening a PR.** Both must pass.
- **Keep dependencies minimal.** Before adding a package, consider whether the standard library or an existing dep covers the use case.
- **No `any`** — prefer `unknown` with a type guard, or a generic with a constraint.

## PR Guidelines

- One feature per PR. Split unrelated changes into separate PRs.
- Include tests for all new functionality. The test runner is Vitest (`npm test`).
- Update `README.md` if adding new MCP tools or changing observable behavior.
- Reference the task board ID (e.g. `T-123`) in the PR description if applicable.

## Security Policy

- Never include memory content in error messages or log output.
- Sanitize all user-supplied strings before embedding them in error responses.
- No external API calls — not in tools, not in the import pipeline, not in tests.
- Report security issues privately via GitHub Security Advisories, not in public issues.

## Architecture Notes

The server uses `better-sqlite3` (synchronous) because MCP stdio transport is inherently synchronous — async DB would add complexity with no benefit. Do not replace it with an async driver.

FTS5 search lives in `src/tools/memory-search.ts`. The tokenizer is `unicode61` (Cyrillic + Latin). Stemming improvements belong in a pre-processing layer, not in the tokenizer config.
