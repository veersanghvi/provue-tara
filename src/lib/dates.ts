// Date parsing helpers.
// The dataset is historical (Jan 2024 - Mar 2025) so relative dates like
// "last month" are resolved against the latest date in the DB, not today.

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export interface DateRange {
  from: string;
  to: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function lastDayOfMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function monthRange(year: number, month1to12: number): DateRange {
  return {
    from: `${year}-${pad(month1to12)}-01`,
    to: `${year}-${pad(month1to12)}-${pad(lastDayOfMonth(year, month1to12))}`,
  };
}

// Handles "2025-03", "March 2025", "March" (year falls back to anchorYear)
export function parseMonth(input: string, anchorYear: number): DateRange | null {
  const s = input.trim().toLowerCase();

  const iso = s.match(/^(\d{4})-(\d{1,2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    if (m >= 1 && m <= 12) return monthRange(y, m);
  }

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

export function quarterRange(year: number, q: 1 | 2 | 3 | 4): DateRange {
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    from: `${year}-${pad(startMonth)}-01`,
    to: `${year}-${pad(endMonth)}-${pad(lastDayOfMonth(year, endMonth))}`,
  };
}

export function asISODate(s: string | undefined | null): string | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return m[0];
}
