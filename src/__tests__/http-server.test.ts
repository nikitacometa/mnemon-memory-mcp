import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";

import { openDatabase } from "../db.js";
import { createHttpServer } from "../http-server.js";

const servers: Server[] = [];
const databases: Database.Database[] = [];

async function startServer(options: {
  authToken?: string;
  corsOrigin?: string;
  rateLimit?: number;
} = {}): Promise<string> {
  const db = openDatabase(":memory:");
  const server = createHttpServer({
    db,
    embedder: null,
    authToken: options.authToken,
    corsOrigin: options.corsOrigin ?? "",
    rateLimit: options.rateLimit ?? 100,
    maxBodyBytes: 1_048_576,
  });
  databases.push(db);
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
  for (const db of databases.splice(0)) db.close();
});

describe("createHttpServer", () => {
  it("returns an ok health response", async () => {
    const baseUrl = await startServer();

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("requires the configured bearer token for MCP requests", async () => {
    const baseUrl = await startServer({ authToken: "correct-token" });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "http-test", version: "1.0.0" },
      },
      id: 1,
    });

    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const authorized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer correct-token",
        "Content-Type": "application/json",
      },
      body,
    });

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).not.toBe(401);
  });

  it("returns 429 after the configured request limit", async () => {
    const baseUrl = await startServer({ rateLimit: 2 });

    const first = await fetch(`${baseUrl}/health`);
    const second = await fetch(`${baseUrl}/health`);
    const third = await fetch(`${baseUrl}/health`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it("only emits CORS headers when an origin is configured", async () => {
    const withoutCorsUrl = await startServer();
    const withCorsUrl = await startServer({ corsOrigin: "https://example.com" });

    const withoutCors = await fetch(`${withoutCorsUrl}/health`);
    const withCors = await fetch(`${withCorsUrl}/health`);

    expect(withoutCors.headers.get("access-control-allow-origin")).toBeNull();
    expect(withCors.headers.get("access-control-allow-origin")).toBe("https://example.com");
  });

  it("handles configured CORS preflight", async () => {
    const baseUrl = await startServer({ corsOrigin: "https://example.com" });

    const response = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS" });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://example.com");
  });
});
