import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { query } from "../db/pool.js";
import { round2 } from "../lib/dbHelpers.js";
import { traceTool } from "../lib/trace.js";

export const detectRecurringInput = z.object({
  min_occurrences: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Minimum number of charges to consider a merchant recurring (default 3)"),
});

export type DetectRecurringInput = z.infer<typeof detectRecurringInput>;

// Cadence / stability thresholds for what counts as a recurring subscription.
const MIN_GAP_DAYS = 20; // roughly monthly cadence ...
const MAX_GAP_DAYS = 38; // ... allowing for billing-date drift
const MAX_CV = 0.45; // coefficient of variation of amount (stable price)

export async function runDetectRecurring(input: DetectRecurringInput) {
  return traceTool("detect_recurring", ["transactions"], input, async () => {
    const minOcc = input.min_occurrences ?? 3;

    const rows = await query<{
      merchant: string;
      merchant_norm: string;
      occurrences: number;
      distinct_months: number;
      avg_amount: number;
      amt_stddev: number;
      avg_gap_days: number | null;
    }>(
      `WITH base AS (
         SELECT merchant_norm, merchant_raw, txn_date, amount
         FROM transactions
         WHERE is_transfer = FALSE AND amount > 0
       ),
       gaps AS (
         SELECT merchant_norm,
                (txn_date - LAG(txn_date) OVER (PARTITION BY merchant_norm ORDER BY txn_date)) AS gap_days
         FROM base
       ),
       gapagg AS (
         SELECT merchant_norm, AVG(gap_days)::float8 AS avg_gap_days
         FROM gaps WHERE gap_days IS NOT NULL GROUP BY merchant_norm
       )
       SELECT b.merchant_norm,
              mode() WITHIN GROUP (ORDER BY b.merchant_raw)        AS merchant,
              COUNT(*)::int                                       AS occurrences,
              COUNT(DISTINCT to_char(b.txn_date, 'YYYY-MM'))::int AS distinct_months,
              AVG(b.amount)::float8                               AS avg_amount,
              COALESCE(STDDEV_POP(b.amount), 0)::float8           AS amt_stddev,
              g.avg_gap_days
       FROM base b
       JOIN gapagg g USING (merchant_norm)
       GROUP BY b.merchant_norm, g.avg_gap_days
       HAVING COUNT(*) >= $1
       ORDER BY occurrences DESC`,
      [minOcc]
    );

    const recurring = rows
      .map((r) => {
        const cv = r.avg_amount > 0 ? r.amt_stddev / r.avg_amount : 1;
        const gap = r.avg_gap_days ?? 0;
        const isRecurring = gap >= MIN_GAP_DAYS && gap <= MAX_GAP_DAYS && cv <= MAX_CV;
        return {
          merchant: r.merchant,
          occurrences: r.occurrences,
          distinct_months: r.distinct_months,
          avg_amount: round2(r.avg_amount),
          amount_cv: round2(cv),
          avg_gap_days: round2(gap),
          is_recurring: isRecurring,
        };
      })
      .filter((r) => r.is_recurring);

    return {
      criteria: {
        min_occurrences: minOcc,
        cadence_days: [MIN_GAP_DAYS, MAX_GAP_DAYS],
        max_amount_coefficient_of_variation: MAX_CV,
        note: "Recurring = regular ~monthly cadence with a stable charge amount. Excludes transfers and refunds.",
      },
      count: recurring.length,
      recurring,
      no_data: recurring.length === 0,
    };
  });
}

export const detectRecurringTool = createTool({
  id: "detect_recurring",
  description:
    "Detect merchants that look like recurring subscriptions: charges that repeat on a roughly " +
    "monthly cadence with a stable amount. Returns the qualifying merchants with occurrence count, " +
    "average amount, cadence and amount variation. Computed in SQL; not based on the 'subscription' " +
    "category label, so it generalizes.",
  inputSchema: detectRecurringInput,
  execute: async ({ context }) => runDetectRecurring(context as DetectRecurringInput),
});
