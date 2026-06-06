import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { query } from "../db/pool.js";
import { getAnchorDates, merchantClause, round2 } from "../lib/dbHelpers.js";
import { parseMonth, quarterRange, asISODate, type DateRange } from "../lib/dates.js";
import { traceTool } from "../lib/trace.js";

export const queryTransactionsInput = z.object({
  filters: z
    .object({
      merchant: z.string().optional().describe("Merchant name to match broadly, e.g. 'Swiggy' (matches Swiggy Instamart, SWIGGY*ORDER, etc.)"),
      category: z.string().optional().describe("Spending category, e.g. food, travel, rent, groceries, subscription, transfer, uncategorized"),
      date_from: z.string().optional().describe("Inclusive start date YYYY-MM-DD"),
      date_to: z.string().optional().describe("Inclusive end date YYYY-MM-DD"),
      month: z.string().optional().describe("A single month: '2025-03', 'March 2025', or 'March'"),
      quarter: z.string().optional().describe("A calendar quarter like 'Q1 2025'"),
      include_transfers: z.boolean().optional().describe("Include self-transfers (default false: transfers are NOT spending)"),
      include_refunds: z.boolean().optional().describe("Include refund/negative rows so they net against spend (default true)"),
      only_refunds: z.boolean().optional().describe("Return ONLY refunds (negative amounts). Default false"),
    })
    .optional(),
  aggregate: z
    .object({
      group_by: z.enum(["merchant", "category", "month", "none"]).optional().describe("Break results down by this dimension. 'none' returns an overall summary + top transactions."),
      metric: z.enum(["net_spend", "gross_spend", "count", "avg"]).optional().describe("Metric used to order grouped results (default net_spend)"),
      top_n: z.number().int().positive().optional().describe("Keep only the top N groups / transactions"),
      order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)"),
    })
    .optional(),
});

export type QueryTransactionsInput = z.infer<typeof queryTransactionsInput>;

function resolveDateRange(
  f: NonNullable<QueryTransactionsInput["filters"]>,
  anchorYear: number
): { range: DateRange | null; note?: string } {
  if (f.month) {
    const r = parseMonth(f.month, anchorYear);
    if (r) return { range: r };
    return { range: null, note: `Could not parse month "${f.month}"` };
  }
  if (f.quarter) {
    const m = f.quarter.trim().toLowerCase().match(/^q([1-4])\s*(\d{4})?$/);
    if (m) {
      const q = Number(m[1]) as 1 | 2 | 3 | 4;
      const y = m[2] ? Number(m[2]) : anchorYear;
      return { range: quarterRange(y, q) };
    }
    return { range: null, note: `Could not parse quarter "${f.quarter}"` };
  }
  const from = asISODate(f.date_from);
  const to = asISODate(f.date_to);
  if (from || to) {
    return {
      range: {
        from: from ?? "0001-01-01",
        to: to ?? "9999-12-31",
      },
    };
  }
  return { range: null };
}

export async function runQueryTransactions(input: QueryTransactionsInput) {
  return traceTool("query_transactions", ["transactions"], input, async () => {
    const f = input.filters ?? {};
    const agg = input.aggregate ?? {};
    const groupBy = agg.group_by ?? "none";
    const metric = agg.metric ?? "net_spend";
    const order = (agg.order ?? "desc").toUpperCase() as "ASC" | "DESC";

    const { txnYear } = await getAnchorDates();

    const where: string[] = [];
    const params: any[] = [];
    let idx = 1;

    // Transfers excluded unless explicitly requested.
    if (!f.include_transfers) where.push("is_transfer = FALSE");

    // Refund handling.
    if (f.only_refunds) {
      where.push("amount < 0");
    } else if (f.include_refunds === false) {
      where.push("amount >= 0");
    }

    // Merchant.
    if (f.merchant && f.merchant.trim()) {
      const mc = merchantClause(f.merchant.trim(), idx);
      where.push(mc.clause);
      params.push(...mc.params);
      idx = mc.nextIdx;
    }

    // Category.
    if (f.category && f.category.trim()) {
      where.push(`category = $${idx}`);
      params.push(f.category.trim().toLowerCase());
      idx += 1;
    }

    // Date range.
    const { range, note } = resolveDateRange(f, txnYear);
    if (range) {
      where.push(`txn_date >= $${idx}`);
      params.push(range.from);
      idx += 1;
      where.push(`txn_date <= $${idx}`);
      params.push(range.to);
      idx += 1;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Always compute an overall summary for the matched set.
    const summaryRows = await query<{
      net_spend: number;
      gross_spend: number;
      refund_total: number;
      txn_count: number;
      avg_txn: number;
    }>(
      `SELECT
         COALESCE(SUM(amount), 0)                          AS net_spend,
         COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) AS gross_spend,
         COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0) AS refund_total,
         COUNT(*)                                          AS txn_count,
         COALESCE(AVG(amount), 0)                          AS avg_txn
       FROM transactions ${whereSql}`,
      params
    );
    const s = summaryRows[0];
    const summary = {
      net_spend: round2(s.net_spend),
      gross_spend: round2(s.gross_spend),
      refund_total: round2(s.refund_total),
      txn_count: Number(s.txn_count),
      avg_txn: round2(s.avg_txn),
      note: "net_spend includes refunds (negatives reduce it); transfers excluded unless requested",
    };

    if (Number(s.txn_count) === 0) {
      return {
        matched_count: 0,
        no_data: true,
        message: note ?? "No transactions matched the given filters.",
        filters_applied: { ...f, resolved_range: range ?? null },
        summary,
      };
    }

    const result: any = {
      matched_count: Number(s.txn_count),
      filters_applied: { ...f, resolved_range: range ?? null },
      summary,
    };

    if (groupBy === "none") {
      // Return the top transactions by absolute amount (covers "biggest expense").
      const limit = agg.top_n ?? 10;
      const rows = await query(
        `SELECT id, txn_date AS date, merchant_raw AS merchant, category,
                amount::float8 AS amount, memo
         FROM transactions ${whereSql}
         ORDER BY amount ${order} NULLS LAST
         LIMIT ${Number.isFinite(limit) ? limit : 10}`,
        params
      );
      result.transactions = rows.map((r: any) => ({ ...r, amount: round2(r.amount) }));
    } else {
      // Grouped aggregation.
      const dim =
        groupBy === "merchant"
          ? "merchant_norm"
          : groupBy === "category"
          ? "category"
          : "to_char(txn_date, 'YYYY-MM')";
      const orderExpr =
        metric === "count"
          ? "count"
          : metric === "gross_spend"
          ? "gross_spend"
          : metric === "avg"
          ? "avg_amount"
          : "net_spend";
      const limitSql = agg.top_n ? `LIMIT ${agg.top_n}` : "";
      const rows = await query(
        `SELECT ${dim} AS key,
                COALESCE(SUM(amount), 0)::float8                          AS net_spend,
                COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)::float8 AS gross_spend,
                COALESCE(AVG(amount), 0)::float8                          AS avg_amount,
                COUNT(*)::int                                            AS count
         FROM transactions ${whereSql}
         GROUP BY key
         ORDER BY ${orderExpr} ${order} NULLS LAST
         ${limitSql}`,
        params
      );
      result.groups = rows.map((r: any) => ({
        key: r.key,
        net_spend: round2(r.net_spend),
        gross_spend: round2(r.gross_spend),
        avg_amount: round2(r.avg_amount),
        count: Number(r.count),
      }));
      result.group_by = groupBy;
    }

    return result;
  });
}

export const queryTransactionsTool = createTool({
  id: "query_transactions",
  description:
    "Query and aggregate the user's transactions. Filter by merchant (matches aliases broadly), " +
    "category, date range / month / quarter. Choose include_transfers, include_refunds, only_refunds. " +
    "Aggregate with group_by (merchant|category|month|none) and metric (net_spend|gross_spend|count|avg), " +
    "optionally top_n. group_by='none' returns an overall summary plus the top transactions by amount " +
    "(use top_n=1 for the single biggest expense). All math is computed in SQL. " +
    "Returns no_data=true when nothing matches - never invent numbers.",
  inputSchema: queryTransactionsInput,
  execute: async ({ context }) => runQueryTransactions(context as QueryTransactionsInput),
});
