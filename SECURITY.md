# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Report security issues via [GitHub Security Advisories](https://github.com/nikitacometa/mnemon-memory-mcp/security/advisories/new).

Expected response time: 48 hours for acknowledgment, 7 days for initial assessment.

## Scope

mnemon-mcp is a local-first tool. By default it opens no ports and sends nothing anywhere; network access happens only when the user opts in — by configuring an embedding provider, or by starting the HTTP transport. Security-relevant areas:

- **SQL injection** — all queries use parameterized statements; FTS5 MATCH input is sanitized
- **Path traversal** — import pipeline validates paths within the configured KB root
- **HTTP transport** — binds `127.0.0.1` by default and refuses a non-loopback bind without `MNEMON_AUTH_TOKEN` (override: `MNEMON_ALLOW_INSECURE_HTTP=1`); Bearer auth with timing-safe comparison; CORS off unless `MNEMON_CORS_ORIGIN` is set; per-IP rate limiting; 1 MB body cap
- **Data at rest** — the database directory is created `0700` and database files `0600`; existing installs are repaired on startup
- **Error output** — tool errors are sanitized before reaching MCP clients: filesystem paths are redacted and full traces go to stderr only
- **Embeddings** — when enabled, memory text is sent to the provider the user configured (their own OpenAI key, or a local Ollama). Choose the provider accordingly; no provider is contacted otherwise

## Known Limitations

Disclosed deliberately rather than discovered later:

- **`memory_delete` is not a secure erase.** The row is removed from `memories`, but `event_log` retains the prior content for auditability, so deleted text remains recoverable from the database file. If you need it gone, delete the event rows too, or treat the whole file as the unit of secrecy (full-disk / filesystem encryption).
- **HTTP transport trusts the socket IP** for rate limiting (`X-Forwarded-For` is deliberately ignored as spoofable). Behind a reverse proxy, rate limits apply to the proxy, not the real client — terminate auth at the proxy in that topology.

## Out of Scope

- Denial of service via large imports (local tool, single user)
- Memory content in error messages (intentionally excluded per CONTRIBUTING.md)
- Multi-tenant isolation — one database file is one user's memory; the HTTP transport's Bearer token is an on/off switch, not per-user authorization
