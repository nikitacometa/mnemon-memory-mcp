/**
 * date-extractor — Parse Russian natural language date patterns from query strings.
 *
 * Supports:
 *   - Exact date: "3 марта 2026"           → date_from=2026-03-03, date_to=2026-03-03
 *   - Month range: "в феврале–марте 2025"  → date_from=2025-02-01, date_to=2025-03-31
 *   - Single month: "в мае 2025"           → date_from=2025-05-01, date_to=2025-05-31
 *
 * Year-only patterns ("2025 года") intentionally not supported — too aggressive,
 * causes regressions on non-temporal queries that mention years contextually.
 *
 * Returns a cleaned query with all matched date tokens stripped.
 */

export interface ExtractedDates {
  date_from: string | null; // ISO date: "2025-02-01"
  date_to: string | null;   // ISO date: "2025-03-31"
  cleanedQuery: string;     // Query with date tokens stripped
}

/** Month name → month number (1-based). All forms normalized to lowercase. */
const MONTH_MAP: Record<string, number> = {
  // January
  январь: 1, января: 1, январе: 1,
  // February
  февраль: 2, февраля: 2, феврале: 2,
  // March
  март: 3, марта: 3, марте: 3,
  // April
  апрель: 4, апреля: 4, апреле: 4,
  // May
  май: 5, мая: 5, мае: 5,
  // June
  июнь: 6, июня: 6, июне: 6,
  // July
  июль: 7, июля: 7, июле: 7,
  // August
  август: 8, августа: 8, августе: 8,
  // September
  сентябрь: 9, сентября: 9, сентябре: 9,
  // October
  октябрь: 10, октября: 10, октябре: 10,
  // November
  ноябрь: 11, ноября: 11, ноябре: 11,
  // December
  декабрь: 12, декабря: 12, декабре: 12,
};

/** Return true if year is a leap year. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Return last day of month (1-based month). */
function lastDayOfMonth(month: number, year: number): number {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31;
    case 4: case 6: case 9: case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 30;
  }
}

/** Format date parts to ISO string "YYYY-MM-DD". */
function toIso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Explicit day-in-month check — avoids Date.UTC normalization quirks. */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

/**
 * Build regex source string for matching any month name.
 * Sorted by length descending to ensure longer forms match first.
 */
function buildMonthPattern(): string {
  const forms = Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length);
  return forms.join("|");
}

const MONTH_PATTERN = buildMonthPattern();

/**
 * Parse Russian date expressions from a natural language query.
 *
 * Patterns (checked in order of specificity):
 *   1. Exact date:   <1-31> <month_gen> <year>
 *   2. Month range:  <month>[–-]<month> <year>
 *   3. Single month: <month> <year>
 *
 * Matching is case-insensitive; ё is treated as е (same as FTS5 normalization).
 */
export function extractDatesFromQuery(query: string): ExtractedDates {
  // Normalize ё→е for matching, keep same string length so character offsets stay valid.
  const norm = query.toLowerCase().replace(/ё/g, "е");
  let date_from: string | null = null;
  let date_to: string | null = null;
  const stripRanges: Array<[number, number]> = [];

  let matched = false;
  let m: RegExpExecArray | null;

  // Pattern 1: Exact date — "3 марта 2026" or "3 марта 2026 года"
  const exactPattern = new RegExp(
    `(\\d{1,2})\\s+(${MONTH_PATTERN})\\s+(\\d{4})(?:\\s+года?(?:у)?)?`,
    "gi"
  );
  exactPattern.lastIndex = 0;
  while ((m = exactPattern.exec(norm)) !== null) {
    const day = parseInt(m[1]!, 10);
    const monthNum = MONTH_MAP[m[2]!];
    const year = parseInt(m[3]!, 10);
    if (monthNum && year >= 1900 && year <= 2099 && isValidCalendarDate(year, monthNum, day)) {
      date_from = toIso(year, monthNum, day);
      date_to = toIso(year, monthNum, day);
      stripRanges.push([m.index, m.index + m[0].length]);
      matched = true;
      break;
    }
  }

  // A day that fails calendar validation must still fall through to the month
  // patterns below: "31 февраля 2025" degrades to February 2025 and gets its
  // date tokens stripped, instead of leaking "31 февраля 2025" into FTS
  if (!matched) {
    // Pattern 2: Month range — "феврале–марте 2025" or "феврале-марте 2025"
    // Dash variants: hyphen (-), en-dash (–, \u2013), em-dash (—, \u2014), figure dash (\u2012)
    const rangePattern = new RegExp(
      `(${MONTH_PATTERN})\\s*[\\-\\u2012\\u2013\\u2014]\\s*(${MONTH_PATTERN})\\s+(\\d{4})(?:\\s+года?(?:у)?)?`,
      "gi"
    );
    rangePattern.lastIndex = 0;
    m = rangePattern.exec(norm);
    if (m) {
      const month1 = MONTH_MAP[m[1]!];
      const month2 = MONTH_MAP[m[2]!];
      const year = parseInt(m[3]!, 10);
      if (month1 && month2 && year >= 1900 && year <= 2099) {
        const fromMonth = Math.min(month1, month2);
        const toMonth = Math.max(month1, month2);
        date_from = toIso(year, fromMonth, 1);
        date_to = toIso(year, toMonth, lastDayOfMonth(toMonth, year));
        stripRanges.push([m.index, m.index + m[0].length]);
        matched = true;
      }
    }
  }

  if (!matched) {
    // Pattern 3: Single month + year — "в мае 2025"
    const singlePattern = new RegExp(
      `(${MONTH_PATTERN})\\s+(\\d{4})(?:\\s+года?(?:у)?)?`,
      "gi"
    );
    singlePattern.lastIndex = 0;
    m = singlePattern.exec(norm);
    if (m) {
      const monthNum = MONTH_MAP[m[1]!];
      const year = parseInt(m[2]!, 10);
      if (monthNum && year >= 1900 && year <= 2099) {
        date_from = toIso(year, monthNum, 1);
        date_to = toIso(year, monthNum, lastDayOfMonth(monthNum, year));
        stripRanges.push([m.index, m.index + m[0].length]);
        matched = true;
      }
    }
  }

  // Pattern 4 (year only) intentionally omitted — too aggressive.
  // "цели на 2025 год" is not a temporal query, it's a topic query mentioning a year.
  // Patterns 1–3 (exact date, month range, single month) are precise enough.

  if (!matched) {
    return { date_from: null, date_to: null, cleanedQuery: query };
  }

  // Strip matched date tokens from the original query.
  // Before stripping, expand each range to absorb a leading "в/во " preposition
  // directly before the date token (common in Russian: "в феврале–марте 2025").
  // Use the normalized string to detect the preposition, but strip from original.
  const expandedRanges = stripRanges.map(([start, end]): [number, number] => {
    // Look backward in norm for optional whitespace + "в" or "во" + whitespace
    const prefix = norm.slice(0, start);
    const prepMatch = /(?:^|(?<=\s))во?\s+$/.exec(prefix);
    if (prepMatch) {
      return [start - prepMatch[0].length, end];
    }
    return [start, end];
  });

  // Apply in reverse order so earlier offsets stay valid
  let cleaned = query;
  const sorted = expandedRanges.slice().sort((a, b) => b[0] - a[0]);
  for (const [start, end] of sorted) {
    cleaned = cleaned.slice(0, start) + " " + cleaned.slice(end);
  }

  // Word boundary pattern for Cyrillic + ASCII (JS \b doesn't work with Cyrillic)
  const wb = "(?<![а-яёА-ЯЁa-zA-Z\\d])";
  const we = "(?![а-яёА-ЯЁa-zA-Z\\d])";

  // Strip residual year words not captured inside the pattern match
  cleaned = cleaned.replace(new RegExp(`${wb}года?${we}`, "gi"), " ");
  cleaned = cleaned.replace(new RegExp(`${wb}году${we}`, "gi"), " ");

  // Collapse whitespace and trim surrounding punctuation
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  cleaned = cleaned.replace(/^[?!.,;:\s—–-]+|[?!.,;:\s—–-]+$/g, "").trim();

  return { date_from, date_to, cleanedQuery: cleaned };
}
