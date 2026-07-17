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

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { openDatabase } from "./db.js";
import { createMcpServer, loadExtraStopWords, version } from "./server.js";
import { createEmbedder } from "./embedder.js";
import { loadSqliteVec, createVecTable } from "./vector.js";

// ---------------------------------------------------------------------------
// Database + config
// ---------------------------------------------------------------------------

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
    createVecTable(db, embedder.dimensions);
  }
} catch (err) {
  // Embedder creation is best-effort — server runs FTS-only without it
  console.error(`[mnemon-mcp http] Embedder disabled: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------------------------------------------------------------------------
// Auth — timing-safe comparison to prevent token extraction via timing attack
// ---------------------------------------------------------------------------

const AUTH_TOKEN = process.env["MNEMON_AUTH_TOKEN"];
const MAX_BODY_BYTES = 1_048_576; // 1 MB
// No CORS by default: server-to-server MCP needs none, and a permissive
// default would let any webpage read a tokenless localhost instance
const CORS_ORIGIN = process.env["MNEMON_CORS_ORIGIN"] ?? "";

// ---------------------------------------------------------------------------
// Rate limiting — simple token bucket per IP
// ---------------------------------------------------------------------------

const RATE_LIMIT = parseInt(process.env["MNEMON_RATE_LIMIT"] ?? "100", 10); // requests per window
const RATE_WINDOW_MS = 60_000; // 1 minute

interface BucketEntry {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, BucketEntry>();

function isRateLimited(ip: string): boolean {
  if (RATE_LIMIT <= 0) return false; // disabled
  const now = Date.now();
  const entry = rateBuckets.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

// Periodic cleanup of stale buckets (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateBuckets) {
    if (now >= entry.resetAt) rateBuckets.delete(ip);
  }
}, 5 * 60_000).unref();

function isAuthorized(req: IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true;
  const header = req.headers["authorization"] ?? "";
  const expected = `Bearer ${AUTH_TOKEN}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function rejectUnauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="mnemon-mcp"' });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

// ---------------------------------------------------------------------------
// HTTP server — stateless mode: new transport + server per request
// ---------------------------------------------------------------------------

function setCorsHeaders(res: ServerResponse): void {
  if (!CORS_ORIGIN) return;
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(res);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Rate limiting
  // Use socket IP directly — x-forwarded-for is trivially spoofable without a trusted proxy
  const clientIp = req.socket.remoteAddress ?? "unknown";
  if (isRateLimited(clientIp)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Too many requests. Try again later." }));
    return;
  }

  if (!isAuthorized(req)) {
    rejectUnauthorized(res);
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost`);

  // Health check endpoint
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use POST /mcp or GET /health" }));
    return;
  }

  // Body size limit — check header first, then enforce on actual body
  const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
  if (contentLength > MAX_BODY_BYTES) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Request body too large (max ${MAX_BODY_BYTES} bytes)` }));
    return;
  }

  // Enforce body size limit on actual stream (handles chunked transfer encoding).
  // The data listener runs concurrently with transport.handleRequest — if the body
  // exceeds the limit, req.destroy() aborts the stream and the transport will fail.
  let receivedBytes = 0;
  const onData = (chunk: Buffer): void => {
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_BODY_BYTES) {
      req.removeListener("data", onData);
      if (!res.headersSent) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Request body too large (max ${MAX_BODY_BYTES} bytes)` }));
      }
      req.destroy();
    }
  };
  req.on("data", onData);

  const transport = new StreamableHTTPServerTransport({});
  const server = createMcpServer(db, embedder);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await server.connect(transport as any);

  try {
    await transport.handleRequest(req, res);
  } finally {
    req.removeListener("data", onData);
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// Start + graceful shutdown
// ---------------------------------------------------------------------------

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

const httpServer = createServer((req, res) => {
  handleHttpRequest(req, res).catch((err) => {
    console.error(`[mnemon-mcp http] Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
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
