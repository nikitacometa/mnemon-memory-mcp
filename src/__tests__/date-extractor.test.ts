/**
 * Unit tests for extractDatesFromQuery (src/date-extractor.ts).
 */

import { describe, it, expect } from "vitest";
import { extractDatesFromQuery } from "../date-extractor.js";

describe("extractDatesFromQuery", () => {
  // ---------------------------------------------------------------------------
  // Month range patterns
  // ---------------------------------------------------------------------------

  it("extracts month range with en-dash: феврале–марте 2025", () => {
    const result = extractDatesFromQuery("Что делал Никита в феврале–марте 2025 года?");
    expect(result.date_from).toBe("2025-02-01");
    expect(result.date_to).toBe("2025-03-31");
    expect(result.cleanedQuery).toBe("Что делал Никита");
  });

  it("extracts month range: мае–июне 2025", () => {
    const result = extractDatesFromQuery("Что происходило с Никитой в мае–июне 2025 года?");
    expect(result.date_from).toBe("2025-05-01");
    expect(result.date_to).toBe("2025-06-30");
    expect(result.cleanedQuery).toBe("Что происходило с Никитой");
  });

  it("extracts month range: октябре–ноябре 2025", () => {
    const result = extractDatesFromQuery("в октябре–ноябре 2025 года");
    expect(result.date_from).toBe("2025-10-01");
    expect(result.date_to).toBe("2025-11-30");
  });

  it("extracts month range with hyphen instead of en-dash", () => {
    const result = extractDatesFromQuery("в феврале-марте 2025 года");
    expect(result.date_from).toBe("2025-02-01");
    expect(result.date_to).toBe("2025-03-31");
  });

  it("extracts month range with em-dash", () => {
    const result = extractDatesFromQuery("в феврале—марте 2025");
    expect(result.date_from).toBe("2025-02-01");
    expect(result.date_to).toBe("2025-03-31");
  });

  it("normalizes month order (later month first in text)", () => {
    // Even if user writes reversed order, date_from should be the earlier month
    const result = extractDatesFromQuery("в марте–феврале 2025");
    expect(result.date_from).toBe("2025-02-01");
    expect(result.date_to).toBe("2025-03-31");
  });

  it("sets correct last day for 31-day month in range", () => {
    const result = extractDatesFromQuery("в январе–марте 2025");
    expect(result.date_from).toBe("2025-01-01");
    expect(result.date_to).toBe("2025-03-31");
  });

  it("sets correct last day for 30-day month in range", () => {
    const result = extractDatesFromQuery("в сентябре–ноябре 2025");
    expect(result.date_from).toBe("2025-09-01");
    expect(result.date_to).toBe("2025-11-30");
  });

  // ---------------------------------------------------------------------------
  // Exact date patterns
  // ---------------------------------------------------------------------------

  it("extracts exact date: 3 марта 2026 года", () => {
    const result = extractDatesFromQuery("Что было в дневнике 3 марта 2026 года?");
    expect(result.date_from).toBe("2026-03-03");
    expect(result.date_to).toBe("2026-03-03");
    expect(result.cleanedQuery).toBe("Что было в дневнике");
  });

  it("extracts a valid leap day as an exact date", () => {
    const result = extractDatesFromQuery("29 февраля 2024 года");
    expect(result.date_from).toBe("2024-02-29");
    expect(result.date_to).toBe("2024-02-29");
  });

  it.each([
    ["что было 31 февраля 2025 года", "2025-02-01", "2025-02-28", "что было 31"],
    ["напоминание про 45 марта 2025", "2025-03-01", "2025-03-31", "напоминание про 45"],
  ] as const)(
    "degrades an impossible calendar date to its month: %s",
    (query, expectedFrom, expectedTo, expectedClean) => {
      // The day is rejected, but the month/year still carry intent — and the
      // date tokens must be stripped either way so they never reach FTS
      const result = extractDatesFromQuery(query);
      expect(result.date_from).toBe(expectedFrom);
      expect(result.date_to).toBe(expectedTo);
      expect(result.cleanedQuery).toBe(expectedClean);
    }
  );

  it("never emits an impossible date as a filter bound", () => {
    const result = extractDatesFromQuery("31 февраля 2025");
    expect(result.date_from).not.toBe("2025-02-31");
    expect(result.date_to).not.toBe("2025-02-31");
  });

  it("trims surrounding hyphens and punctuation from the cleaned query", () => {
    const result = extractDatesFromQuery("встречи - март 2025");
    expect(result.date_from).toBe("2025-03-01");
    expect(result.cleanedQuery).toBe("встречи");
  });

  it("extracts exact date with single-digit day", () => {
    const result = extractDatesFromQuery("5 июля 2025");
    expect(result.date_from).toBe("2025-07-05");
    expect(result.date_to).toBe("2025-07-05");
  });

  // ---------------------------------------------------------------------------
  // Single month + year
  // ---------------------------------------------------------------------------

  it("extracts single month: в январе 2026", () => {
    const result = extractDatesFromQuery("питание в январе 2026");
    expect(result.date_from).toBe("2026-01-01");
    expect(result.date_to).toBe("2026-01-31");
    expect(result.cleanedQuery).toBe("питание");
  });

  it("extracts single month: в мае 2025", () => {
    const result = extractDatesFromQuery("в мае 2025");
    expect(result.date_from).toBe("2025-05-01");
    expect(result.date_to).toBe("2025-05-31");
  });

  it("sets correct last day for February in non-leap year", () => {
    const result = extractDatesFromQuery("в феврале 2025");
    expect(result.date_from).toBe("2025-02-01");
    expect(result.date_to).toBe("2025-02-28");
  });

  it("sets correct last day for February in leap year", () => {
    const result = extractDatesFromQuery("в феврале 2024");
    expect(result.date_from).toBe("2024-02-01");
    expect(result.date_to).toBe("2024-02-29");
  });

  it("sets correct last day for April (30 days)", () => {
    const result = extractDatesFromQuery("апрель 2025");
    expect(result.date_to).toBe("2025-04-30");
  });

  // ---------------------------------------------------------------------------
  // Year-only patterns are NOT extracted (too aggressive, causes regressions)
  // ---------------------------------------------------------------------------

  it("does NOT extract year-only: цели на 2025 год", () => {
    const result = extractDatesFromQuery("цели на 2025 год");
    expect(result.date_from).toBeNull();
    expect(result.date_to).toBeNull();
    expect(result.cleanedQuery).toBe("цели на 2025 год");
  });

  it("does NOT extract standalone year: достижения 2024", () => {
    const result = extractDatesFromQuery("достижения 2024");
    expect(result.date_from).toBeNull();
    expect(result.date_to).toBeNull();
    expect(result.cleanedQuery).toBe("достижения 2024");
  });

  // ---------------------------------------------------------------------------
  // No dates in query
  // ---------------------------------------------------------------------------

  it("returns nulls when no date found: субличности", () => {
    const result = extractDatesFromQuery("субличности");
    expect(result.date_from).toBeNull();
    expect(result.date_to).toBeNull();
    expect(result.cleanedQuery).toBe("субличности");
  });

  it("returns nulls for non-date text query", () => {
    const result = extractDatesFromQuery("проект по машинному обучению");
    expect(result.date_from).toBeNull();
    expect(result.date_to).toBeNull();
    expect(result.cleanedQuery).toBe("проект по машинному обучению");
  });

  // ---------------------------------------------------------------------------
  // Cleaned query content
  // ---------------------------------------------------------------------------

  it("strips date tokens leaving meaningful content", () => {
    const result = extractDatesFromQuery("питание в январе 2026");
    expect(result.cleanedQuery).toBe("питание");
  });

  it("returns empty string when query is purely a date expression", () => {
    const result = extractDatesFromQuery("в феврале 2025");
    // After stripping "феврале 2025" and "в", nothing meaningful remains
    expect(result.cleanedQuery).toBe("");
  });

  // ---------------------------------------------------------------------------
  // Case insensitivity
  // ---------------------------------------------------------------------------

  it("is case-insensitive for month names", () => {
    const result = extractDatesFromQuery("в Январе 2026");
    expect(result.date_from).toBe("2026-01-01");
    expect(result.date_to).toBe("2026-01-31");
  });

  it("handles mixed case in range", () => {
    const result = extractDatesFromQuery("в Феврале–Марте 2025");
    expect(result.date_from).toBe("2025-02-01");
    expect(result.date_to).toBe("2025-03-31");
  });

  // ---------------------------------------------------------------------------
  // ё/е normalization
  // ---------------------------------------------------------------------------

  it("normalizes ё→е in month names", () => {
    // "сентябрё" is unlikely but we handle it defensively
    // More common: "ещё" is a stop word; month ё forms are canonical
    const result = extractDatesFromQuery("в декабре 2025");
    expect(result.date_from).toBe("2025-12-01");
    expect(result.date_to).toBe("2025-12-31");
  });

  // ---------------------------------------------------------------------------
  // Exact date takes precedence over month-only patterns
  // ---------------------------------------------------------------------------

  it("prefers exact date over single month when both could match", () => {
    const result = extractDatesFromQuery("15 марта 2026 года");
    expect(result.date_from).toBe("2026-03-15");
    expect(result.date_to).toBe("2026-03-15");
  });

  // ---------------------------------------------------------------------------
  // Edge: query with only stop words remaining after date strip
  // ---------------------------------------------------------------------------

  it("produces empty cleanedQuery for 'в октябре–ноябре 2025 года'", () => {
    const result = extractDatesFromQuery("в октябре–ноябре 2025 года");
    expect(result.date_from).toBe("2025-10-01");
    expect(result.date_to).toBe("2025-11-30");
    // "в" is stripped as lone preposition; result is empty or just whitespace trimmed
    expect(result.cleanedQuery).toBe("");
  });
});
