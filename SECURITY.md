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

mnemon-mcp is a local-first tool — it makes zero network calls by design (unless HTTP transport is explicitly enabled). Security-relevant areas:

- **SQL injection** — all queries use parameterized statements; FTS5 MATCH input is sanitized
- **Path traversal** — import pipeline validates paths within the configured KB root
- **HTTP transport** — Bearer token auth with timing-safe comparison; 1MB body size limit
- **Data at rest** — SQLite database stored at `~/.mnemon-mcp/memory.db` with user-only permissions

## Out of Scope

- Denial of service via large imports (local tool, single user)
- Memory content in error messages (intentionally excluded per CONTRIBUTING.md)
