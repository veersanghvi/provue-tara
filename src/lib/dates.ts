/**
 * Date helpers for resolving the date filters a non-deterministic LLM may pass.
 *
 * The dataset is historical (transactions Jan 2024–Mar 2025), so relative terms
 * like "last month" are meaningless against wall-clock time. We resolve them
 * against an anchor date supplied by the caller (the latest date present in the
 * data). See DESIGN.md "Relative-date policy".
 */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export interface DateRange {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function lastDayOfMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** First/last day of a given year+month. */
export function monthRange(year: number, month1to12: number): DateRange {
  const from = `${year}-${pad(month1to12)}-01`;
  const to = `${year}-${pad(month1to12)}-${pad(lastDayOfMonth(year, month1to12))}`;
  return { from, to };
}

/**
 * Parse a loose "month" string the model might pass, e.g.:
 *   "2025-03", "March 2025", "Mar 2025", "March".
 * If the year is omitted, fall back to the anchor year (latest data year).
 */
export function parseMonth(input: string, anchorYear: number): DateRange | null {
  const s = input.trim().toLowerCase();

  // YYYY-MM
  const iso = s.match(/^(\d{4})-(\d{1,2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    if (m >= 1 && m <= 12) return monthRange(y, m);
  }

  // "<month name> <year?>"
  const named = s.match(/^([a-z]+)\.?\s*(\d{4})?$/);
  if (named) {
    const m = MONTHS[named[1]];
    if (m) {
      const y = named[2] ? Number(named[2]) : anchorYear;
      return monthRange(y, m);
    }
  }

  return null;
}

/** Quarter range, e.g. quarter "Q1" of 2025. */
export function quarterRange(year: number, q: 1 | 2 | 3 | 4): DateRange {
  const startMonth = (q - 1) * 3 + 1;
  const from = `${year}-${pad(startMonth)}-01`;
  const endMonth = startMonth + 2;
  const to = `${year}-${pad(endMonth)}-${pad(lastDayOfMonth(year, endMonth))}`;
  return { from, to };
}

/** Validate a YYYY-MM-DD string. Returns it untouched if valid, else null. */
export function asISODate(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return m[0];
}
