import { queryOne } from "../db/pool.js";
import { normalizeQueryTerm } from "./normalize.js";

/**
 * Anchor dates derived from the data itself. The dataset is historical, so
 * "today"/"last month" are resolved against these, not wall-clock time.
 */
export interface AnchorDates {
  latestTxnDate: string | null; // YYYY-MM-DD
  latestNavDate: string | null; // YYYY-MM-DD
  txnYear: number; // year of latest txn, used as default year for bare month names
}

export async function getAnchorDates(): Promise<AnchorDates> {
  const row = await queryOne<{ latest_txn: string | null; latest_nav: string | null }>(
    `SELECT (SELECT max(txn_date) FROM transactions) AS latest_txn,
            (SELECT max(nav_date) FROM fund_nav)     AS latest_nav`
  );
  const latestTxnDate = row?.latest_txn ?? null;
  const latestNavDate = row?.latest_nav ?? null;
  const txnYear = latestTxnDate ? Number(latestTxnDate.slice(0, 4)) : new Date().getUTCFullYear();
  return { latestTxnDate, latestNavDate, txnYear };
}

/**
 * Build a SQL fragment + params that match a merchant search term broadly:
 *   - exact normalized brand anchor (collapses Swiggy / SWIGGY*ORDER / ...)
 *   - raw substring (ILIKE) for partial typed names
 *   - trigram similarity for minor spelling variants
 *
 * `startIdx` is the next positional placeholder number to use.
 * Returns { clause, params } where clause is wrapped in parentheses.
 */
export function merchantClause(
  term: string,
  startIdx: number
): { clause: string; params: any[]; nextIdx: number } {
  const anchor = normalizeQueryTerm(term);
  const i = startIdx;
  const clause = `(
    merchant_norm = $${i}
    OR merchant_raw ILIKE '%' || $${i + 1} || '%'
    OR similarity(merchant_norm, $${i}) > 0.45
  )`;
  return { clause, params: [anchor, term], nextIdx: i + 2 };
}

export function round2(n: number | null | undefined): number {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
