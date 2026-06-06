import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { query } from "../db/pool.js";
import { getAnchorDates, round2 } from "../lib/dbHelpers.js";
import { asISODate } from "../lib/dates.js";
import { traceTool } from "../lib/trace.js";

export const fundReturnInput = z.object({
  fund: z.string().optional().describe("Fund name or id. Omit (or set all=true) to compute for every fund."),
  all: z.boolean().optional().describe("Compute for all funds and rank them (default false unless fund omitted)."),
  date_from: z.string().optional().describe("Period start YYYY-MM-DD. Defaults to the earliest available NAV."),
  date_to: z.string().optional().describe("Period end YYYY-MM-DD. Defaults to the latest available NAV."),
});

export type FundReturnInput = z.infer<typeof fundReturnInput>;

export async function runFundReturn(input: FundReturnInput) {
  return traceTool("fund_return", ["funds", "fund_nav"], input, async () => {
    const { latestNavDate } = await getAnchorDates();

    // Resolve date window. NAV series is monthly; we use nearest NAV on/before each date.
    const navBounds = await query<{ min_date: string; max_date: string }>(
      `SELECT min(nav_date) AS min_date, max(nav_date) AS max_date FROM fund_nav`
    );
    const dateFrom = asISODate(input.date_from) ?? navBounds[0]?.min_date ?? null;
    const dateTo = asISODate(input.date_to) ?? latestNavDate ?? navBounds[0]?.max_date ?? null;

    if (!dateFrom || !dateTo) {
      return { no_data: true, message: "No NAV data available to compute returns." };
    }

    const wantAll = input.all === true || !input.fund;

    const params: any[] = [dateFrom, dateTo];
    let fundFilter = "TRUE";
    if (!wantAll && input.fund) {
      const term = input.fund.trim();
      fundFilter = `(f.id = $3 OR f.name ILIKE '%' || $3 || '%' OR similarity(f.name, $3) > 0.3)`;
      params.push(term);
    }

    const rows = await query<{
      id: string;
      name: string;
      category: string | null;
      start_nav: number | null;
      start_date: string | null;
      end_nav: number | null;
      end_date: string | null;
    }>(
      `SELECT f.id, f.name, f.category,
         (SELECT nav      FROM fund_nav n WHERE n.fund_id=f.id AND n.nav_date <= $1 ORDER BY n.nav_date DESC LIMIT 1) AS start_nav,
         (SELECT nav_date FROM fund_nav n WHERE n.fund_id=f.id AND n.nav_date <= $1 ORDER BY n.nav_date DESC LIMIT 1) AS start_date,
         (SELECT nav      FROM fund_nav n WHERE n.fund_id=f.id AND n.nav_date <= $2 ORDER BY n.nav_date DESC LIMIT 1) AS end_nav,
         (SELECT nav_date FROM fund_nav n WHERE n.fund_id=f.id AND n.nav_date <= $2 ORDER BY n.nav_date DESC LIMIT 1) AS end_date
       FROM funds f
       WHERE ${fundFilter}`,
      params
    );

    if (rows.length === 0) {
      return {
        no_data: true,
        message: input.fund
          ? `No fund matched "${input.fund}".`
          : "No funds found.",
      };
    }

    const funds = rows.map((r) => {
      const computable = r.start_nav != null && r.end_nav != null && Number(r.start_nav) !== 0;
      const returnPct = computable
        ? round2(((Number(r.end_nav) - Number(r.start_nav)) / Number(r.start_nav)) * 100)
        : null;
      return {
        fund_id: r.id,
        name: r.name,
        category: r.category,
        start_date_used: r.start_date,
        start_nav: r.start_nav != null ? round2(Number(r.start_nav)) : null,
        end_date_used: r.end_date,
        end_nav: r.end_nav != null ? round2(Number(r.end_nav)) : null,
        period_return_pct: returnPct,
        computable,
      };
    });

    funds.sort((a, b) => (b.period_return_pct ?? -Infinity) - (a.period_return_pct ?? -Infinity));

    const computables = funds.filter((f) => f.period_return_pct != null);
    const result: any = {
      kind: "fund_period_return",
      definition: "Period return = (end NAV - start NAV) / start NAV. Market data, independent of holdings.",
      requested_window: { date_from: dateFrom, date_to: dateTo },
      funds: wantAll ? funds : funds,
    };

    if (wantAll && computables.length > 0) {
      const best = computables[0];
      const worst = computables[computables.length - 1];
      result.ranking = {
        best: { name: best.name, period_return_pct: best.period_return_pct },
        worst: { name: worst.name, period_return_pct: worst.period_return_pct },
        spread_pct_points: round2((best.period_return_pct ?? 0) - (worst.period_return_pct ?? 0)),
      };
    }

    if (!wantAll) {
      result.fund = funds[0];
    }

    return result;
  });
}

export const fundReturnTool = createTool({
  id: "fund_return",
  description:
    "Compute a fund's PERIOD RETURN between two dates from its NAV history (market data, independent " +
    "of what the user owns). Pass a fund name/id for one fund, or all=true (or omit fund) to rank every " +
    "fund and report the best/worst spread. Uses the nearest NAV on or before each date. " +
    "This is NOT the user's realised return on a holding — use holding_return for that.",
  inputSchema: fundReturnInput,
  execute: async ({ context }) => runFundReturn(context as FundReturnInput),
});
