import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbedder } from "../embedder.js";

const ENV_KEYS = [
  "MNEMON_EMBEDDING_PROVIDER",
  "MNEMON_EMBEDDING_API_KEY",
  "OPENAI_API_KEY",
  "MNEMON_EMBEDDING_MODEL",
  "MNEMON_EMBEDDING_DIMENSIONS",
  "OPENAI_BASE_URL",
  "MNEMON_OLLAMA_URL",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("createEmbedder", () => {
  it("creates an OpenAI embedder with provider defaults", () => {
    process.env["MNEMON_EMBEDDING_PROVIDER"] = "openai";
    process.env["MNEMON_EMBEDDING_API_KEY"] = "test-key";

    const embedder = createEmbedder();

    expect({
      provider: embedder?.provider,
      model: embedder?.model,
      dimensions: embedder?.dimensions,
    }).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1024,
    });
  });

  it("creates an Ollama embedder with provider defaults", () => {
    process.env["MNEMON_EMBEDDING_PROVIDER"] = "ollama";

    const embedder = createEmbedder();

    expect({
      provider: embedder?.provider,
      model: embedder?.model,
      dimensions: embedder?.dimensions,
    }).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
    });
  });

  it("throws when an OpenAI API key is missing", () => {
    process.env["MNEMON_EMBEDDING_PROVIDER"] = "openai";

    expect(() => createEmbedder()).toThrow(
      "MNEMON_EMBEDDING_API_KEY or OPENAI_API_KEY required for OpenAI embeddings"
    );
  });
});

describe("OpenAI embedder", () => {
  beforeEach(() => {
    process.env["MNEMON_EMBEDDING_PROVIDER"] = "openai";
    process.env["MNEMON_EMBEDDING_API_KEY"] = "test-key";
    process.env["MNEMON_EMBEDDING_MODEL"] = "custom-openai-model";
    process.env["MNEMON_EMBEDDING_DIMENSIONS"] = "3";
    process.env["OPENAI_BASE_URL"] = "https://openai.example/v1";
  });

  it("constructs a batch request and parses embeddings in input order", async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { embedding: [4, 5, 6], index: 1 },
        { embedding: [1, 2, 3], index: 0 },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    const embedder = createEmbedder()!;

    const result = await embedder.embedBatch(["first", "second"]);

    expect(result).toEqual([
      new Float32Array([1, 2, 3]),
      new Float32Array([4, 5, 6]),
    ]);
    expect(fetchStub).toHaveBeenCalledWith("https://openai.example/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
      },
      body: JSON.stringify({
        model: "custom-openai-model",
        input: ["first", "second"],
        dimensions: 3,
        encoding_format: "float",
      }),
    });
  });

  it("propagates API errors with status and response body", async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("rate limited", { status: 429 })
    );
    vi.stubGlobal("fetch", fetchStub);
    const embedder = createEmbedder()!;

    await expect(embedder.embed("text")).rejects.toThrow(
      "OpenAI embeddings API error 429: rate limited"
    );
  });
});

describe("Ollama embedder", () => {
  beforeEach(() => {
    process.env["MNEMON_EMBEDDING_PROVIDER"] = "ollama";
    process.env["MNEMON_EMBEDDING_MODEL"] = "custom-ollama-model";
    process.env["MNEMON_EMBEDDING_DIMENSIONS"] = "2";
    process.env["MNEMON_OLLAMA_URL"] = "http://ollama.example:11434";
  });

  it("constructs a single request and parses its embedding", async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      embeddings: [[1, 2]],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    const embedder = createEmbedder()!;

    const result = await embedder.embed("single text");

    expect(result).toEqual(new Float32Array([1, 2]));
    expect(fetchStub).toHaveBeenCalledWith("http://ollama.example:11434/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "custom-ollama-model", input: "single text" }),
    });
  });

  it("constructs a batch request and parses all embeddings", async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      embeddings: [[1, 2], [3, 4]],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    const embedder = createEmbedder()!;

    const result = await embedder.embedBatch(["first", "second"]);

    expect(result).toEqual([
      new Float32Array([1, 2]),
      new Float32Array([3, 4]),
    ]);
    expect(fetchStub).toHaveBeenCalledWith("http://ollama.example:11434/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "custom-ollama-model", input: ["first", "second"] }),
    });
  });

  it("propagates API errors with status and response body", async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("model unavailable", { status: 503 })
    );
    vi.stubGlobal("fetch", fetchStub);
    const embedder = createEmbedder()!;

    await expect(embedder.embedBatch(["text"])).rejects.toThrow(
      "Ollama embeddings error 503: model unavailable"
    );
  });
});
