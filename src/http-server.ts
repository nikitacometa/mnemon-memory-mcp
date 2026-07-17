import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type Database from "better-sqlite3";

import type { Embedder } from "./embedder.js";
import { createMcpServer, version } from "./server.js";

export interface HttpServerOptions {
  db: Database.Database;
  embedder: Embedder | null;
  authToken: string | undefined;
  corsOrigin: string;
  rateLimit: number;
  maxBodyBytes: number;
}

interface BucketEntry {
  count: number;
  resetAt: number;
}

const RATE_WINDOW_MS = 60_000; // 1 minute

/** Create the HTTP transport server without binding it to a port. */
export function createHttpServer(options: HttpServerOptions): Server {
  const rateBuckets = new Map<string, BucketEntry>();

  function isRateLimited(ip: string): boolean {
    if (options.rateLimit <= 0) return false; // disabled
    const now = Date.now();
    const entry = rateBuckets.get(ip);
    if (!entry || now >= entry.resetAt) {
      rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
      return false;
    }
    entry.count++;
    return entry.count > options.rateLimit;
  }

  // Periodic cleanup of stale buckets (every 5 minutes)
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateBuckets) {
      if (now >= entry.resetAt) rateBuckets.delete(ip);
    }
  }, 5 * 60_000);
  cleanupTimer.unref();

  function isAuthorized(req: IncomingMessage): boolean {
    if (!options.authToken) return true;
    const header = req.headers["authorization"] ?? "";
    const expected = `Bearer ${options.authToken}`;
    if (header.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  }

  function rejectUnauthorized(res: ServerResponse): void {
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="mnemon-mcp"' });
    res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  function setCorsHeaders(res: ServerResponse): void {
    if (!options.corsOrigin) return;
    res.setHeader("Access-Control-Allow-Origin", options.corsOrigin);
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

    const url = new URL(req.url ?? "/", "http://localhost");

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
    if (contentLength > options.maxBodyBytes) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Request body too large (max ${options.maxBodyBytes} bytes)` }));
      return;
    }

    // Enforce body size limit on actual stream (handles chunked transfer encoding).
    // The data listener runs concurrently with transport.handleRequest — if the body
    // exceeds the limit, req.destroy() aborts the stream and the transport will fail.
    let receivedBytes = 0;
    const onData = (chunk: Buffer): void => {
      receivedBytes += chunk.length;
      if (receivedBytes > options.maxBodyBytes) {
        req.removeListener("data", onData);
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Request body too large (max ${options.maxBodyBytes} bytes)` }));
        }
        req.destroy();
      }
    };
    req.on("data", onData);

    const transport = new StreamableHTTPServerTransport({});
    const mcpServer = createMcpServer(options.db, options.embedder);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mcpServer.connect(transport as any);

    try {
      await transport.handleRequest(req, res);
    } finally {
      req.removeListener("data", onData);
      await mcpServer.close();
    }
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

  httpServer.once("close", () => clearInterval(cleanupTimer));
  return httpServer;
}
