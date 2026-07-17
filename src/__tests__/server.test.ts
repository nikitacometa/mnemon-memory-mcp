import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type Database from "better-sqlite3";

import { openDatabase } from "../db.js";
import type { Embedder } from "../embedder.js";
import { createMcpServer } from "../server.js";
import { createVecTable, loadSqliteVec } from "../vector.js";

let db: Database.Database;
let server: Server;
let client: Client;

async function connect(embedder?: Embedder): Promise<void> {
  server = createMcpServer(db, embedder);
  client = new Client({ name: "server-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}

function responseText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  if (!("content" in result) || !Array.isArray(result.content)) {
    throw new Error("Expected immediate tool result");
  }
  const content = result.content[0];
  if (
    typeof content !== "object" ||
    content === null ||
    !("type" in content) ||
    content.type !== "text" ||
    !("text" in content) ||
    typeof content.text !== "string"
  ) {
    throw new Error("Expected text tool result");
  }
  return content.text;
}

describe("createMcpServer", () => {
  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    db.close();
  });

  it("lists exactly the ten memory tools", async () => {
    await connect();

    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "memory_add",
      "memory_search",
      "memory_update",
      "memory_delete",
      "memory_inspect",
      "memory_export",
      "memory_health",
      "memory_session_start",
      "memory_session_end",
      "memory_session_list",
    ]);
  });

  it("dispatches memory_add and persists the row", async () => {
    await connect();

    const result = await client.callTool({
      name: "memory_add",
      arguments: { content: "stored through MCP", layer: "semantic" },
    });
    const parsed = JSON.parse(responseText(result)) as { id: string };
    const row = db.prepare<[string], { content: string }>(
      "SELECT content FROM memories WHERE id = ?"
    ).get(parsed.id);

    expect(parsed.id).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.content).toBe("stored through MCP");
  });

  it("keeps memory_add successful when embedding rejects", async () => {
    expect(loadSqliteVec(db)).toBe(true);
    createVecTable(db, 4);
    const rejectingEmbedder: Embedder & { calls: number } = {
      dimensions: 4,
      provider: "test",
      model: "rejecting",
      calls: 0,
      embed: async () => {
        rejectingEmbedder.calls++;
        throw new Error("embedding unavailable");
      },
      embedBatch: async () => {
        throw new Error("embedding unavailable");
      },
    };
    await connect(rejectingEmbedder);

    const result = await client.callTool({
      name: "memory_add",
      arguments: { content: "survives embedding failure", layer: "semantic" },
    });
    const parsed = JSON.parse(responseText(result)) as { id: string; created: boolean };

    expect(result.isError).not.toBe(true);
    expect(parsed.created).toBe(true);
    expect(rejectingEmbedder.calls).toBe(1);
  });

  it("sanitizes filesystem paths in tool errors", async () => {
    await connect();
    const absolutePath = "/private/tmp/secret-memory.db";

    const result = await client.callTool({
      name: "memory_update",
      arguments: { id: absolutePath, content: "unused" },
    });
    const text = responseText(result);

    expect(result.isError).toBe(true);
    expect(text).not.toContain(absolutePath);
    expect(text).toContain("<path>");
  });

  it("reads memory://stats as valid JSON", async () => {
    await connect();

    const result = await client.readResource({ uri: "memory://stats" });
    const content = result.contents[0];
    if (!content || !("text" in content)) throw new Error("Expected text resource");

    expect(content.mimeType).toBe("application/json");
    expect(() => JSON.parse(content.text)).not.toThrow();
  });

  it("returns messages for the recall prompt", async () => {
    await connect();

    const result = await client.getPrompt({
      name: "recall",
      arguments: { topic: "TypeScript" },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("user");
  });
});
