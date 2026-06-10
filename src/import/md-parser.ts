/**
 * Markdown parser — frontmatter extraction, heading-based splitting, hashing.
 */

import { createHash } from "node:crypto";

export interface Frontmatter {
  [key: string]: unknown;
  layer?: string;
  last_updated?: string;
  description?: string;
  tags?: string[];
  importance?: number;
  /** entity name for "from-frontmatter" mappings (e.g. person name in per-person files) */
  entity?: string;
}

export interface Section {
  title: string;
  level: number;
  content: string;
}

export interface ParsedFile {
  frontmatter: Frontmatter;
  body: string;
  hash: string;
}

/** Parse YAML frontmatter delimited by --- */
export function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const yamlBlock = match[1]!;
  const body = match[2]!;
  const frontmatter: Frontmatter = {};

  for (const line of yamlBlock.split("\n")) {
    const kv = line.match(/^(\w[\w_-]*)\s*:\s*(.+)$/);
    if (!kv) continue;

    const key = kv[1]!;
    let value: unknown = kv[2]!.trim();
    let wasQuoted = false;

    // Strip surrounding quotes (YAML-style) — quoted values stay as strings
    if (typeof value === "string" && value.length >= 2) {
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
        wasQuoted = true;
      }
    }

    // Parse arrays: [a, b, c]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim());
    }
    // Parse numbers — only for unquoted values (quoted "0012" stays "0012")
    else if (!wasQuoted && typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) {
      value = parseFloat(value);
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

/** Split markdown by heading level (H2 or H3) into sections */
export function splitByHeading(body: string, level: 2 | 3): Section[] {
  const prefix = "#".repeat(level) + " ";
  const lines = body.split("\n");
  const sections: Section[] = [];

  let currentTitle = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(prefix)) {
      // Save previous section (skip prelude content before first heading)
      if (currentTitle) {
        const content = currentLines.join("\n").trim();
        if (content) {
          sections.push({ title: currentTitle, level, content });
        }
      }
      currentTitle = line.slice(prefix.length).trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Last section (skip if no heading was encountered)
  if (currentTitle) {
    const content = currentLines.join("\n").trim();
    if (content) {
      sections.push({ title: currentTitle, level, content });
    }
  }

  return sections;
}

/** Extract date from section title: "22.02.2025 [NARRATIVE]", "19.05.2025 — описание [TAG]" → ISO string */
export function extractDateFromSectionTitle(title: string): string | null {
  // DD.MM.YYYY at the start of the title
  const dotFormat = title.match(/^(\d{1,2})\.(\d{2})\.(\d{4})/);
  if (dotFormat) {
    const day = dotFormat[1]!.padStart(2, "0");
    const month = dotFormat[2]!;
    const year = dotFormat[3]!;
    return `${year}-${month}-${day}T00:00:00Z`;
  }

  // YYYY-MM-DD at the start of the title
  const isoFormat = title.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoFormat) {
    return `${isoFormat[1]}-${isoFormat[2]}-${isoFormat[3]}T00:00:00Z`;
  }

  return null;
}

/** Extract date from filename: 2026-03-05.md, 2025-q1.md, 2024.md → ISO string */
export function extractDateFromFilename(filename: string): string | null {
  // Daily: 2026-03-05.md
  const daily = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (daily) return `${daily[1]}T00:00:00Z`;

  // Quarterly: 2025-q1.md → first day of quarter
  const quarterly = filename.match(/(\d{4})-q([1-4])/i);
  if (quarterly) {
    const month = String(([1, 4, 7, 10] as const)[(+quarterly[2]! - 1)]).padStart(2, "0");
    return `${quarterly[1]}-${month}-01T00:00:00Z`;
  }

  // Yearly: 2024.md
  const yearly = filename.match(/^(\d{4})\.md$/);
  if (yearly) return `${yearly[1]}-01-01T00:00:00Z`;

  return null;
}

/** Compute SHA-256 hash of content */
export function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Full parse: frontmatter + body + hash */
export function parseFile(raw: string): ParsedFile {
  const { frontmatter, body } = parseFrontmatter(raw);
  const hash = computeHash(raw);
  return { frontmatter, body, hash };
}
