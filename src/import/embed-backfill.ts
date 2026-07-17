#!/usr/bin/env node
/**
 * Batch embedding backfill for existing memories.
 *
 * Finds all active memories (superseded_by IS NULL) that are missing
 * from memories_vec, and embeds them in batches via the configured
 * embedding provider.
 *
 * Environment variables (see src/embedder.ts):
 *   MNEMON_EMBEDDING_PROVIDER   — "openai" | "ollama"
 *   MNEMON_EMBEDDING_API_KEY    — API key (required for OpenAI)
 *   MNEMON_EMBEDDING_MODEL      — model name (default: text-embedding-3-small)
 *   MNEMON_EMBEDDING_DIMENSIONS — vector dimensions (default: 1024)
 *
 * Usage:
 *   tsx src/import/embed-backfill.ts                    # embed un-embedded active memories
 *   tsx src/import/embed-backfill.ts --force            # re-embed everything
 *   tsx src/import/embed-backfill.ts --batch-size 100
 */

import { openDatabase } from "../db.js";
import { createEmbedder } from "../embedder.js";
import {
  createVecTable,
  isVecLoaded,
  loadSqliteVec,
  upsertVec,
  vecCount,
} from "../vector.js";

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 2048;

interface CliArgs {
  force: boolean;
  batchSize: number;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = { force: false, batchSize: DEFAULT_BATCH_SIZE };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--force":
        result.force = true;
        break;
      case "--batch-size": {
        const n = parseInt(next ?? "", 10);
        if (isNaN(n) || n < 1) {
          console.error(`ERROR: --batch-size must be a positive integer, got: ${next}`);
          process.exit(1);
        }
        result.batchSize = Math.min(n, MAX_BATCH_SIZE);
        i++;
        break;
      }
      case "--help":
      case "-h":
        console.log(
          [
            "Usage: tsx src/import/embed-backfill.ts [options]",
            "",
            "Options:",
            "  --force            Re-embed all active memories (ignore existing embeddings)",
            `  --batch-size N     Batch size for API calls (default: ${DEFAULT_BATCH_SIZE}, max: ${MAX_BATCH_SIZE})`,
            "  -h, --help         Show this help",
            "",
            "Environment variables:",
            "  MNEMON_EMBEDDING_PROVIDER   — 'openai' | 'ollama'",
            "  MNEMON_EMBEDDING_API_KEY    — API key (required for OpenAI)",
            "  MNEMON_EMBEDDING_MODEL      — model name (default: text-embedding-3-small)",
            "  MNEMON_EMBEDDING_DIMENSIONS — vector dimensions (default: 1024)",
          ].join("\n")
        );
        process.exit(0);
    }
  }

  return result;
}

interface MemoryStub {
  id: string;
  title: string | null;
  content: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 1. Open database
  const db = openDatabase();

  // 2. Load sqlite-vec — REQUIRED
  const vecOk = loadSqliteVec(db);
  if (!vecOk) {
    console.error("ERROR: Failed to load sqlite-vec extension.");
    console.error("Install with: npm install sqlite-vec");
    db.close();
    process.exit(1);
  }

  // 3. Create embedder — REQUIRED
  const embedder = createEmbedder();
  if (!embedder) {
    console.error("ERROR: No embedding provider configured.");
    console.error("Set MNEMON_EMBEDDING_PROVIDER=openai and MNEMON_EMBEDDING_API_KEY=sk-...");
    db.close();
    process.exit(1);
  }

  const modelTag = `${embedder.provider}:${embedder.model}:${embedder.dimensions}`;
  console.log(`Embedder: ${modelTag}`);
  console.log(`Batch size: ${args.batchSize}`);

  // Different embedding spaces cannot share a vec0 table, and vec0 fixes its
  // dimensions at creation time. A forced backfill must rebuild both records.
  if (args.force) {
    db.prepare("DROP TABLE IF EXISTS memories_vec").run();
    db.prepare("DELETE FROM vector_index_meta").run();
    console.log("--force: cleared the vector index.");
  }

  // 4. Ensure vec table exists with the correct dimensions
  createVecTable(db, embedder.dimensions, embedder);
  if (!isVecLoaded()) {
    console.error("ERROR: Vector index is incompatible with the configured embedder.");
    db.close();
    process.exit(1);
  }

  // 5. Find memories to embed.
  //    --force:   all active memories
  //    default:   active memories NOT already in memories_vec
  //
  // Use subquery instead of LEFT JOIN — vec0 virtual tables may not support
  // LEFT JOIN in all sqlite-vec versions.
  const query = args.force
    ? `SELECT id, title, content
       FROM memories
       WHERE superseded_by IS NULL
       ORDER BY created_at ASC`
    : `SELECT id, title, content
       FROM memories
       WHERE superseded_by IS NULL
         AND id NOT IN (SELECT memory_id FROM memories_vec)
       ORDER BY created_at ASC`;

  const memories = db.prepare<[], MemoryStub>(query).all();
  const total = memories.length;

  if (total === 0) {
    const existing = vecCount(db);
    console.log("Nothing to embed — all active memories already have embeddings.");
    console.log(`Total embeddings in DB: ${existing}`);
    db.close();
    return;
  }

  console.log(`Memories to embed: ${total}`);

  // 6. Batch embed with progress reporting
  const updateEmbeddingModel = db.prepare<[string, string], void>(
    "UPDATE memories SET embedding_model = ? WHERE id = ?"
  );

  const startTime = Date.now();
  let embedded = 0;
  let failed = 0;
  const failedBatches: Array<{ batchIndex: number; error: string }> = [];
  const batchCount = Math.ceil(total / args.batchSize);

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    const start = batchIndex * args.batchSize;
    const batch = memories.slice(start, start + args.batchSize);
    const batchStart = Date.now();

    try {
      // Prepare texts: combine title + content when title is available.
      // Truncate to ~6000 tokens worth of chars (conservative estimate for
      // text-embedding-3-small's 8191 token limit with Cyrillic text).
      const MAX_CHARS = 16_000;
      const texts = batch.map((m) => {
        const raw = m.title ? `${m.title}\n\n${m.content}` : m.content;
        return raw.length > MAX_CHARS ? raw.slice(0, MAX_CHARS) : raw;
      });

      const embeddings = await embedder.embedBatch(texts);

      // Write embeddings and update model tag inside a transaction for atomicity
      const writeEmbeddings = db.transaction(() => {
        for (let i = 0; i < batch.length; i++) {
          const memory = batch[i]!;
          const embedding = embeddings[i]!;
          upsertVec(db, memory.id, embedding);
          updateEmbeddingModel.run(modelTag, memory.id);
        }
      });
      writeEmbeddings();

      embedded += batch.length;
      const elapsed = ((Date.now() - batchStart) / 1000).toFixed(1);
      console.log(
        `Embedded ${embedded}/${total} (batch ${batchIndex + 1}/${batchCount}, ${elapsed}s)`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `ERROR: Batch ${batchIndex + 1}/${batchCount} failed (memories ${start + 1}–${start + batch.length}): ${message}`
      );
      failedBatches.push({ batchIndex: batchIndex + 1, error: message });
      failed += batch.length;
    }
  }

  // 7. Final summary
  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const finalCount = vecCount(db);

  console.log("");
  console.log(
    `Done. Embedded: ${embedded}/${total}. Skipped: 0. Failed: ${failed}.`
  );
  console.log(`Total embeddings in DB: ${finalCount}`);
  console.log(`Model: ${modelTag}`);
  console.log(`Time: ${totalElapsed}s`);

  if (failedBatches.length > 0) {
    console.error(`\nFailed batches (${failedBatches.length}):`);
    for (const fb of failedBatches) {
      console.error(`  Batch ${fb.batchIndex}: ${fb.error}`);
    }
  }

  db.close();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
