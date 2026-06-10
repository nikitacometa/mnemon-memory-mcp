/**
 * KB import configuration types.
 *
 * Actual mappings are loaded at runtime from ~/.mnemon-mcp/config.json
 * (or MNEMON_CONFIG_PATH env var). See config-loader.ts.
 *
 * For the config file format, see config.example.json in the repo root.
 */

import type { EntityType, Layer } from "../types.js";

export interface FileMapping {
  layer: Layer;
  entity_type: EntityType;
  importance: number;
  confidence: number;
  split: "whole" | "h2" | "h3";
  /** entity_name to use; "from-heading" extracts from H2/H3 heading text,
   *  "from-frontmatter" reads `entity:` frontmatter field (fallback: file stem) */
  entity_name?: string | "from-heading" | "from-frontmatter";
  scope?: string;
}

export interface DirectoryMapping extends Omit<FileMapping, "split"> {
  /** glob pattern relative to KB root */
  glob: string;
  split: "whole" | "h2" | "h3";
  /** filter function for filenames (e.g. only 2026-*.md) */
  fileFilter?: (filename: string) => boolean;
}
