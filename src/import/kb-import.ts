/**
 * KB import pipeline — reads markdown files from mnemon-kb, splits into memories,
 * and inserts into mnemon-mcp SQLite database.
 *
 * Idempotent: uses import_log + file_hash for dedup.
 * Superseding: re-import of changed files supersedes old memories via source_file.
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { globSync } from "node:fs";
import type Database from "better-sqlite3";
import { openDatabase } from "../db.js";
import { memoryAdd } from "../tools/memory-add.js";
import type { Layer, EntityType, MemoryAddInput } from "../types.js";
import {
  type DirectoryMapping,
  type FileMapping,
} from "./kb-config.js";
import { loadConfig, type LoadedConfig } from "./config-loader.js";
import {
  parseFile,
  splitByHeading,
  extractDateFromFilename,
  extractDateFromSectionTitle,
  type Section,
} from "./md-parser.js";

export interface ImportOptions {
  kbPath: string;
  configPath?: string | undefined;
  dryRun?: boolean | undefined;
  singleFile?: string | undefined;
  singleLayer?: Layer | undefined;
  verbose?: boolean | undefined;
  force?: boolean | undefined;
}

export interface ImportResult {
  filesProcessed: number;
  filesSkipped: number;
  memoriesCreated: number;
  memoriesSuperseded: number;
  errors: Array<{ file: string; error: string }>;
  details: Array<{
    file: string;
    sections: number;
    status: "imported" | "skipped" | "updated" | "error";
  }>;
}

/** Expand ~ in paths */
function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

/** Resolve glob patterns against a base path */
function resolveGlob(pattern: string, basePath: string): string[] {
  const fullPattern = join(basePath, pattern);
  try {
    return globSync(fullPattern);
  } catch {
    return [];
  }
}

/** Check if the file's MOST RECENT import used this hash (unchanged file).
 *  Comparing against the full history would skip files reverted to earlier
 *  content while the DB still holds memories from the newer version. */
function isAlreadyImported(db: Database.Database, sourcePath: string, hash: string): boolean {
  const row = db
    .prepare<[string], { file_hash: string | null }>(
      `SELECT file_hash FROM import_log
       WHERE source_path = ?
       ORDER BY imported_at DESC, rowid DESC
       LIMIT 1`
    )
    .get(sourcePath);
  return row !== undefined && row.file_hash === hash;
}

/** Log import to import_log table */
function logImport(
  db: Database.Database,
  sourcePath: string,
  sourceType: string,
  hash: string,
  created: number,
  updated: number,
  status: string,
  errors: string[] = []
): void {
  db.prepare(
    `INSERT OR REPLACE INTO import_log (source_path, source_type, file_hash, memories_created, memories_updated, status, errors)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sourcePath, sourceType, hash, created, updated, status, JSON.stringify(errors));
}

/** Build MemoryAddInput from a section + mapping config */
function buildMemoryInput(
  section: Section | null,
  fullContent: string,
  mapping: FileMapping,
  sourcePath: string,
  filename: string,
  description?: string
): MemoryAddInput {
  // Prepend file stem (e.g. "human-design") + description for FTS discoverability
  // File stem helps find files by name (e.g. query "Human Design" matches "human-design")
  const fileStem = basename(filename, ".md");
  const descPrefix = section && description ? `[${description}]\n\n` : "";
  const fileTag = `[file: ${fileStem}] `;
  const content = section
    ? `${fileTag}${descPrefix}## ${section.title}\n\n${section.content}`
    : `${fileTag}${fullContent}`;
  const title = section?.title ?? basename(filename, ".md");

  let entityName = mapping.entity_name;
  if (entityName === "from-heading" && section) {
    // Extract first meaningful part of heading (before —, (, etc.)
    entityName = section.title.split(/\s*[—\-(|]/)[0]!.trim();
  } else if (entityName === "from-heading") {
    entityName = undefined;
  }

  const eventAt = mapping.layer === "episodic"
    ? (section ? extractDateFromSectionTitle(section.title) : null)
      ?? extractDateFromFilename(filename)
    : undefined;

  // source_file includes section title for per-section superseding
  const sourceFile = section ? `${sourcePath}#${section.title}` : sourcePath;

  return {
    content,
    layer: mapping.layer,
    title,
    entity_type: mapping.entity_type,
    ...(entityName ? { entity_name: entityName } : {}),
    importance: mapping.importance,
    confidence: mapping.confidence,
    source: "import:kb",
    source_file: sourceFile,
    scope: mapping.scope ?? "global",
    ...(eventAt ? { event_at: eventAt } : {}),
    meta: { imported_from: sourcePath },
  };
}

/** Process a single file with its mapping */
export function processFile(
  db: Database.Database,
  filePath: string,
  mapping: FileMapping,
  kbPath: string,
  dryRun: boolean,
  verbose: boolean,
  force: boolean = false
): { sections: number; created: number; superseded: number; status: "imported" | "skipped" | "updated" | "error"; error?: string } {
  const sourcePath = filePath.startsWith(kbPath)
    ? relative(kbPath, filePath)
    : filePath;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return { sections: 0, created: 0, superseded: 0, status: "error", error: `Read error: ${err}` };
  }

  const parsed = parseFile(raw);

  // Use frontmatter layer override if present
  const effectiveMapping = { ...mapping };
  if (parsed.frontmatter.layer && ["episodic", "semantic", "procedural", "resource"].includes(parsed.frontmatter.layer)) {
    effectiveMapping.layer = parsed.frontmatter.layer as Layer;
  }

  // Resolve "from-frontmatter" entity_name: `entity:` field, fallback to file stem
  if (effectiveMapping.entity_name === "from-frontmatter") {
    const fmEntity = typeof parsed.frontmatter.entity === "string" ? parsed.frontmatter.entity.trim() : "";
    effectiveMapping.entity_name = fmEntity || basename(filePath, ".md");
  }

  // Check if already imported with same hash
  if (!force && isAlreadyImported(db, sourcePath, parsed.hash)) {
    if (verbose) console.log(`  SKIP (unchanged): ${sourcePath}`);
    return { sections: 0, created: 0, superseded: 0, status: "skipped" };
  }

  const filename = basename(filePath);
  let created = 0;
  let superseded = 0;

  // Prepend frontmatter description to body so it gets indexed in FTS5 (T-093)
  const descriptionPrefix = parsed.frontmatter.description
    ? `${parsed.frontmatter.description}\n\n`
    : "";
  const bodyWithDescription = descriptionPrefix + parsed.body;

  try {
    if (effectiveMapping.split === "whole") {
      // Import as single memory
      const input = buildMemoryInput(null, bodyWithDescription, effectiveMapping, sourcePath, filename);
      if (dryRun) {
        if (verbose) console.log(`  DRY: ${sourcePath} → 1 record (whole), layer=${input.layer}`);
        return { sections: 1, created: 1, superseded: 0, status: "imported" };
      }
      const result = memoryAdd(db, input);
      created = 1;
      superseded = result.superseded_ids?.length ?? 0;
    } else {
      // Split by heading
      const level = effectiveMapping.split === "h2" ? 2 : 3;
      const sections = splitByHeading(parsed.body, level);

      const fmDescription = typeof parsed.frontmatter.description === "string"
        ? parsed.frontmatter.description : undefined;

      if (sections.length === 0) {
        // File has no headings at the specified level — import as whole
        const input = buildMemoryInput(null, bodyWithDescription, effectiveMapping, sourcePath, filename);
        if (dryRun) {
          if (verbose) console.log(`  DRY: ${sourcePath} → 1 record (no headings), layer=${input.layer}`);
          return { sections: 1, created: 1, superseded: 0, status: "imported" };
        }
        const result = memoryAdd(db, input);
        created = 1;
        superseded = result.superseded_ids?.length ?? 0;
      } else {
        for (const section of sections) {
          if (!section.content.trim()) continue;
          const input = buildMemoryInput(section, "", effectiveMapping, sourcePath, filename, fmDescription);
          if (dryRun) {
            if (verbose) console.log(`  DRY: ${sourcePath}#${section.title} → layer=${input.layer}`);
            created++;
            continue;
          }
          const result = memoryAdd(db, input);
          created++;
          superseded += result.superseded_ids?.length ?? 0;
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (verbose) console.error(`  ERROR: ${sourcePath}: ${errMsg}`);
    return { sections: 0, created: 0, superseded: 0, status: "error", error: errMsg };
  }

  if (!dryRun) {
    logImport(db, sourcePath, "kb-markdown", parsed.hash, created, superseded, "success");
    if (verbose) console.log(`  OK: ${sourcePath} → ${created} records, ${superseded} superseded`);
  }

  return {
    sections: created,
    created,
    superseded,
    status: superseded > 0 ? "updated" : "imported",
  };
}

/** Main import function */
export function runImport(options: ImportOptions): ImportResult {
  const kbPath = resolve(expandHome(options.kbPath));
  const dryRun = options.dryRun ?? false;
  const verbose = options.verbose ?? false;
  const force = options.force ?? false;

  if (!existsSync(kbPath)) {
    throw new Error(`KB path does not exist: ${kbPath}`);
  }

  const config = loadConfig(options.configPath);

  const db = dryRun ? openDatabase(":memory:") : openDatabase();
  const result: ImportResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    memoriesCreated: 0,
    memoriesSuperseded: 0,
    errors: [],
    details: [],
  };

  // Single file mode
  if (options.singleFile) {
    const filePath = resolve(expandHome(options.singleFile));
    if (!existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    // Find matching mapping or use provided layer
    let mapping: FileMapping | undefined;
    const relPath = filePath.startsWith(kbPath) ? relative(kbPath, filePath) : filePath;

    for (const dirMapping of config.mappings) {
      const matches = resolveGlob(dirMapping.glob, kbPath);
      if (matches.includes(filePath)) {
        mapping = dirMapping;
        break;
      }
    }

    if (!mapping && options.singleLayer) {
      mapping = {
        layer: options.singleLayer,
        entity_type: "concept",
        importance: 0.5,
        confidence: 0.8,
        split: "h2",
      };
    }

    if (!mapping) {
      throw new Error(`No mapping found for ${relPath}. Use --layer to specify.`);
    }

    const fileResult = processFile(db, filePath, mapping, kbPath, dryRun, verbose, force);
    result.filesProcessed = 1;
    result.memoriesCreated = fileResult.created;
    result.memoriesSuperseded = fileResult.superseded;
    result.details.push({ file: relPath, sections: fileResult.sections, status: fileResult.status });
    if (fileResult.error) {
      result.errors.push({ file: relPath, error: fileResult.error });
    }

    db.close();
    return result;
  }

  // Full KB import
  for (const dirMapping of config.mappings) {
    const files = resolveGlob(dirMapping.glob, kbPath);

    for (const filePath of files) {
      const filename = basename(filePath);

      // Apply file filter if defined
      if (dirMapping.fileFilter && !dirMapping.fileFilter(filename)) continue;

      result.filesProcessed++;
      const relPath = relative(kbPath, filePath);
      const fileResult = processFile(db, filePath, dirMapping, kbPath, dryRun, verbose, force);

      if (fileResult.status === "skipped") {
        result.filesSkipped++;
      } else {
        result.memoriesCreated += fileResult.created;
        result.memoriesSuperseded += fileResult.superseded;
      }

      result.details.push({ file: relPath, sections: fileResult.sections, status: fileResult.status });
      if (fileResult.error) {
        result.errors.push({ file: relPath, error: fileResult.error });
      }
    }
  }

  // External files
  for (const ext of config.externalFiles) {
    const filePath = resolve(expandHome(ext.path));
    if (!existsSync(filePath)) {
      if (verbose) console.log(`  SKIP (not found): ${ext.path}`);
      continue;
    }

    result.filesProcessed++;
    const fileResult = processFile(db, filePath, ext.mapping, kbPath, dryRun, verbose, force);

    if (fileResult.status === "skipped") {
      result.filesSkipped++;
    } else {
      result.memoriesCreated += fileResult.created;
      result.memoriesSuperseded += fileResult.superseded;
    }

    result.details.push({ file: ext.path, sections: fileResult.sections, status: fileResult.status });
    if (fileResult.error) {
      result.errors.push({ file: ext.path, error: fileResult.error });
    }
  }

  db.close();
  return result;
}
