import { queryOne } from "../db/pool.js";
import { normalizeQueryTerm } from "./normalize.js";

export interface AnchorDates {
  latestTxnDate: string | null;
  latestNavDate: string | null;
  txnYear: number;
}

// Pull the latest dates from the DB so relative terms ("last month", "today")
// resolve against the actual data, not the current date.
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

// Builds a SQL clause that matches a merchant broadly:
// exact anchor match + raw substring + trigram similarity fallback
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
