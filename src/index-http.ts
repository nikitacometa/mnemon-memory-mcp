/**
 * mnemon-mcp: HTTP transport entry point.
 *
 * Exposes the same tools as index.ts via StreamableHTTP transport.
 * Use for remote / multi-server deployments instead of stdio.
 *
 * Environment variables:
 *   MNEMON_PORT       - Listening port (default: 3000)
 *   MNEMON_AUTH_TOKEN - Bearer token for all requests (optional but recommended)
 */

import { openDatabase } from "./db.js";
import { createEmbedder } from "./embedder.js";
import { createHttpServer } from "./http-server.js";
import { loadExtraStopWords, version } from "./server.js";
import { createVecTable, loadSqliteVec } from "./vector.js";

let db: ReturnType<typeof openDatabase>;

try {
  db = openDatabase();
} catch (err) {
  console.error(`[mnemon-mcp http] Failed to open database: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

loadExtraStopWords();

// Optional: load sqlite-vec extension and create vector table
const vecAvailable = loadSqliteVec(db);

let embedder: ReturnType<typeof createEmbedder> = null;
try {
  embedder = createEmbedder();
  if (embedder && vecAvailable) {
    createVecTable(db, embedder.dimensions, embedder);
  }
} catch (err) {
  // Embedder creation is best-effort — server runs FTS-only without it
  console.error(`[mnemon-mcp http] Embedder disabled: ${err instanceof Error ? err.message : String(err)}`);
}

const AUTH_TOKEN = process.env["MNEMON_AUTH_TOKEN"];
const MAX_BODY_BYTES = 1_048_576; // 1 MB
// No CORS by default: server-to-server MCP needs none, and a permissive
// default would let any webpage read a tokenless localhost instance
const CORS_ORIGIN = process.env["MNEMON_CORS_ORIGIN"] ?? "";
const RATE_LIMIT = parseInt(process.env["MNEMON_RATE_LIMIT"] ?? "100", 10); // requests per window

const portRaw = parseInt(process.env["MNEMON_PORT"] ?? "3000", 10);
if (Number.isNaN(portRaw) || portRaw < 1 || portRaw > 65535) {
  console.error(`[mnemon-mcp http] Invalid MNEMON_PORT: "${process.env["MNEMON_PORT"]}". Must be 1-65535.`);
  process.exit(1);
}
const PORT = portRaw;

// Loopback by default — exposing the full memory store beyond localhost
// requires an auth token (or an explicit insecure opt-in for trusted networks)
const HOST = process.env["MNEMON_HOST"] ?? "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!AUTH_TOKEN && !LOOPBACK_HOSTS.has(HOST) && process.env["MNEMON_ALLOW_INSECURE_HTTP"] !== "1") {
  console.error(
    `[mnemon-mcp http] Refusing to bind to ${HOST} without MNEMON_AUTH_TOKEN — ` +
      `this would expose the entire memory store to the network. ` +
      `Set MNEMON_AUTH_TOKEN, or set MNEMON_ALLOW_INSECURE_HTTP=1 to override on a trusted network.`
  );
  process.exit(1);
}

const httpServer = createHttpServer({
  db,
  embedder,
  authToken: AUTH_TOKEN,
  corsOrigin: CORS_ORIGIN,
  rateLimit: RATE_LIMIT,
  maxBodyBytes: MAX_BODY_BYTES,
});

function shutdown(): void {
  console.error("[mnemon-mcp http] Shutting down...");
  httpServer.close(() => {
    try {
      db.close();
    } catch {
      // Best-effort
    }
    process.exit(0);
  });
  // Force exit after 5s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

httpServer.listen(PORT, HOST, () => {
  console.error(`[mnemon-mcp http] v${version} listening on ${HOST}:${PORT}${AUTH_TOKEN ? " (auth enabled)" : " (no auth — set MNEMON_AUTH_TOKEN for production)"}`);
  console.error(`[mnemon-mcp http] MCP endpoint: POST http://localhost:${PORT}/mcp`);
  console.error(`[mnemon-mcp http] Health check: GET http://localhost:${PORT}/health`);
});
