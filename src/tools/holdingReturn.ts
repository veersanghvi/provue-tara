import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { query } from "../db/pool.js";
import { getAnchorDates, round2 } from "../lib/dbHelpers.js";
import { traceTool } from "../lib/trace.js";

export const holdingReturnInput = z.object({
  fund: z.string().optional().describe(
    "Fund name or id for a specific holding. Omit to get all holdings + portfolio aggregate."
  ),
});

export type HoldingReturnInput = z.infer<typeof holdingReturnInput>;

export async function runHoldingReturn(input: HoldingReturnInput) {
  return traceTool("holding_return", ["holdings", "fund_nav", "funds"], input, async () => {
    const { latestNavDate } = await getAnchorDates();

    if (!latestNavDate) {
      return { no_data: true, message: "No NAV data in the database." };
    }

    const params: any[] = [latestNavDate];
    let fundFilter = "TRUE";
    if (input.fund && input.fund.trim()) {
      const term = input.fund.trim();
      fundFilter = `(f.id = $2 OR f.name ILIKE '%' || $2 || '%' OR similarity(f.name, $2) > 0.3)`;
      params.push(term);
    }

    const rows = await query<{
      holding_id: number;
      fund_id: string;
      fund_name: string;
      units: number;
      purchase_date: string;
      purchase_nav: number;
      latest_nav: number | null;
      latest_nav_date: string | null;
      // period return over the holding window (for the "mixed" question)
      start_nav_for_holding: number | null;
    }>(
      `SELECT h.id              AS holding_id,
              h.fund_id,
              h.fund_name,
              h.units::float8     AS units,
              h.purchase_date,
              h.purchase_nav::float8 AS purchase_nav,
              (SELECT nav      FROM fund_nav n WHERE n.fund_id=h.fund_id AND n.nav_date <= $1 ORDER BY n.nav_date DESC LIMIT 1) AS latest_nav,
              (SELECT nav_date FROM fund_nav n WHERE n.fund_id=h.fund_id AND n.nav_date <= $1 ORDER BY n.nav_date DESC LIMIT 1) AS latest_nav_date,
              (SELECT nav      FROM fund_nav n WHERE n.fund_id=h.fund_id AND n.nav_date <= h.purchase_date ORDER BY n.nav_date DESC LIMIT 1) AS start_nav_for_holding
       FROM holdings h
       JOIN funds f ON f.id = h.fund_id
       WHERE ${fundFilter}
       ORDER BY h.id`,
      params
    );

    if (rows.length === 0) {
      return {
        no_data: true,
        message: input.fund
          ? `No holding matched "${input.fund}". Check if the fund is in the portfolio.`
          : "No holdings found in the database.",
      };
    }

    const holdings = rows.map((r) => {
      const latestNav = r.latest_nav != null ? Number(r.latest_nav) : null;
      const purchaseNav = Number(r.purchase_nav);
      const units = Number(r.units);
      const cost = round2(units * purchaseNav);
      const currentValue = latestNav != null ? round2(units * latestNav) : null;
      const absReturn = currentValue != null ? round2(currentValue - cost) : null;
      const returnPct =
        currentValue != null && cost !== 0
          ? round2(((currentValue - cost) / cost) * 100)
          : null;

      // Period return for the same fund over the holding's window
      // (for the "mixed" question comparing holding return vs fund return).
      const startNavForHolding = r.start_nav_for_holding != null ? Number(r.start_nav_for_holding) : null;
      const fundPeriodReturnPct =
        startNavForHolding != null && latestNav != null && startNavForHolding !== 0
          ? round2(((latestNav - startNavForHolding) / startNavForHolding) * 100)
          : null;

      return {
        holding_id: r.holding_id,
        fund_id: r.fund_id,
        fund_name: r.fund_name,
        units,
        purchase_date: r.purchase_date,
        purchase_nav: round2(purchaseNav),
        cost_inr: cost,
        latest_nav_date: r.latest_nav_date,
        latest_nav: latestNav != null ? round2(latestNav) : null,
        current_value_inr: currentValue,
        absolute_return_inr: absReturn,
        realised_return_pct: returnPct,
        // The same fund's NAV change over the same window (purchase_date → latest_nav_date).
        // Lets the agent contrast "my return" vs "the fund's return over my holding period".
        fund_period_return_pct_same_window: fundPeriodReturnPct,
      };
    });

    // Portfolio aggregate (all holdings).
    const validHoldings = holdings.filter((h) => h.current_value_inr != null);
    const totalCost = round2(validHoldings.reduce((s, h) => s + h.cost_inr, 0));
    const totalValue = round2(validHoldings.reduce((s, h) => s + (h.current_value_inr ?? 0), 0));
    const totalGain = round2(totalValue - totalCost);
    const portfolioReturnPct = totalCost !== 0 ? round2((totalGain / totalCost) * 100) : null;

    return {
      kind: "holding_return",
      definition:
        "Realised return = (current_value - cost) / cost. " +
        "current_value = units × latest NAV. cost = units × purchase_nav. " +
        "fund_period_return_pct_same_window is the same fund's NAV-only return over the same window " +
        "(purchase_date → latest NAV date) for comparison.",
      as_of_nav_date: latestNavDate,
      holdings: input.fund ? holdings[0] : holdings,
      portfolio: {
        total_cost_inr: totalCost,
        total_value_inr: totalValue,
        total_gain_inr: totalGain,
        portfolio_return_pct: portfolioReturnPct,
        holdings_count: validHoldings.length,
      },
    };
  });
}

export const holdingReturnTool = createTool({
  id: "holding_return",
  description:
    "Compute the user's REALISED RETURN on their mutual fund holdings: current value vs purchase cost. " +
    "Returns per-holding breakdown (cost, current value, absolute + % return) and portfolio totals. " +
    "Also returns the same fund's period return over the holding window for side-by-side comparison. " +
    "Pass fund= to query one holding, or omit for the full portfolio. " +
    "This is NOT the fund's market period return between arbitrary dates — use fund_return for that.",
  inputSchema: holdingReturnInput,
  execute: async ({ context }) => runHoldingReturn(context as HoldingReturnInput),
});
