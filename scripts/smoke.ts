/**
 * Deterministic smoke test — verifies tool correctness by comparing tool
 * output against direct SQL queries. No LLM required.
 *
 * Run: npx tsx scripts/smoke.ts
 * Requires: DATABASE_URL in .env, sample_a loaded (npm run ingest).
 */
import * as dotenv from "dotenv";
dotenv.config();

import { query, closePool } from "../src/db/pool.js";
import { runQueryTransactions } from "../src/tools/queryTransactions.js";
import { runDetectRecurring } from "../src/tools/detectRecurring.js";
import { runFundReturn } from "../src/tools/fundReturn.js";
import { runHoldingReturn } from "../src/tools/holdingReturn.js";

let passed = 0;
let failed = 0;

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function check(label: string, got: any, expected: any) {
  const g = typeof got === "number" ? round2(got) : got;
  const e = typeof expected === "number" ? round2(expected) : expected;
  const ok = Math.abs(g - e) < 0.02; // 2-cent tolerance for floating point
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}  got=${g}  expected=${e}`);
    failed++;
  }
}

async function checkBool(label: string, got: boolean, expected: boolean) {
  if (got === expected) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}  got=${got}  expected=${expected}`);
    failed++;
  }
}

async function main() {
  console.log("=== Smoke test (sample_a must be loaded) ===\n");

  // ── 1. Food spending in March 2025 (net, after refunds, excl transfers) ─────
  console.log("1. Food spending March 2025 (net)");
  const [sqlFood] = await query<{ net: number }>(
    `SELECT COALESCE(SUM(amount),0)::float8 AS net FROM transactions
     WHERE category='food' AND txn_date>='2025-03-01' AND txn_date<='2025-03-31'
       AND is_transfer=FALSE`
  );
  const toolFood = await runQueryTransactions({
    filters: { category: "food", month: "2025-03" },
    aggregate: { group_by: "none" },
  });
  await check("food net spend March 2025", toolFood.summary.net_spend, sqlFood.net);

  // ── 2. Biggest expense (single transaction, descending by amount) ──────────
  console.log("2. Biggest single expense");
  const [sqlBig] = await query<{ amount: number }>(
    `SELECT amount::float8 FROM transactions WHERE is_transfer=FALSE ORDER BY amount DESC LIMIT 1`
  );
  const toolBig = await runQueryTransactions({
    filters: {},
    aggregate: { group_by: "none", top_n: 1, order: "desc" },
  });
  await check("biggest expense amount", toolBig.transactions?.[0]?.amount, sqlBig.amount);

  // ── 3. Swiggy total spend (all alias variants) ────────────────────────────
  console.log("3. Swiggy total (all aliases)");
  const [sqlSwiggy] = await query<{ net: number }>(
    `SELECT COALESCE(SUM(amount),0)::float8 AS net FROM transactions
     WHERE merchant_norm='SWIGGY' AND is_transfer=FALSE`
  );
  const toolSwiggy = await runQueryTransactions({ filters: { merchant: "Swiggy" } });
  await check("swiggy net spend", toolSwiggy.summary.net_spend, sqlSwiggy.net);

  // ── 4. Transfers excluded by default ─────────────────────────────────────
  console.log("4. Transfers excluded from overall spend");
  const [sqlTransferTotal] = await query<{ total_with: number; total_without: number }>(
    `SELECT SUM(amount)::float8 AS total_with,
            SUM(amount) FILTER (WHERE is_transfer=FALSE)::float8 AS total_without
     FROM transactions`
  );
  const toolNoTransfer = await runQueryTransactions({ filters: {} });
  // Tool default should match total_without
  await check(
    "default excl transfers matches SQL",
    toolNoTransfer.summary.net_spend,
    sqlTransferTotal.total_without
  );

  // ── 5. Top category by net spend ──────────────────────────────────────────
  console.log("5. Top category by net spend");
  const [sqlTopCat] = await query<{ category: string; net: number }>(
    `SELECT category, SUM(amount)::float8 AS net FROM transactions
     WHERE is_transfer=FALSE GROUP BY category ORDER BY net DESC LIMIT 1`
  );
  const toolCats = await runQueryTransactions({
    filters: {},
    aggregate: { group_by: "category", metric: "net_spend", top_n: 1, order: "desc" },
  });
  await check("top category net spend", toolCats.groups?.[0]?.net_spend, sqlTopCat.net);

  // ── 6. No-data case ───────────────────────────────────────────────────────
  console.log("6. No-data: rent in April 2025");
  const toolNoData = await runQueryTransactions({
    filters: { category: "rent", date_from: "2025-04-01", date_to: "2025-04-30" },
  });
  await checkBool("no_data flag set", toolNoData.no_data === true, true);

  // ── 7. Recurring subscriptions detected ───────────────────────────────────
  console.log("7. Recurring subscriptions (>=3 occurrences)");
  const toolRecurring = await runDetectRecurring({ min_occurrences: 3 });
  await checkBool("at least 1 recurring merchant found", toolRecurring.count > 0, true);

  // ── 8. Fund return — Saffron Bluechip 2024-01-01 to 2025-01-01 ───────────
  console.log("8. Fund return: Saffron Bluechip 2024-01-01 to 2025-01-01");
  const [navStart] = await query<{ nav: number }>(
    `SELECT nav::float8 FROM fund_nav WHERE fund_id='fund_bluechip' AND nav_date<='2024-01-01'
     ORDER BY nav_date DESC LIMIT 1`
  );
  const [navEnd] = await query<{ nav: number }>(
    `SELECT nav::float8 FROM fund_nav WHERE fund_id='fund_bluechip' AND nav_date<='2025-01-01'
     ORDER BY nav_date DESC LIMIT 1`
  );
  const expectedReturn =
    navStart && navEnd
      ? round2(((navEnd.nav - navStart.nav) / navStart.nav) * 100)
      : null;
  const toolFundReturn = await runFundReturn({
    fund: "fund_bluechip",
    date_from: "2024-01-01",
    date_to: "2025-01-01",
  });
  if (expectedReturn != null) {
    const fundResult = toolFundReturn.fund ?? toolFundReturn.funds?.[0];
    await check("Saffron Bluechip 1yr return %", fundResult?.period_return_pct, expectedReturn);
  } else {
    console.log("  ⚠ skipped (no NAV data for fund_bluechip in range)");
  }

  // ── 9. All-fund ranking — best fund should have highest return ────────────
  console.log("9. All-fund ranking");
  const toolAllFunds = await runFundReturn({ all: true, date_from: "2024-01-01", date_to: "2025-01-01" });
  const fundsArr: any[] = toolAllFunds.funds ?? [];
  if (fundsArr.length > 1) {
    const sorted = [...fundsArr].filter((f: any) => f.period_return_pct != null)
      .sort((a: any, b: any) => b.period_return_pct - a.period_return_pct);
    await checkBool("funds sorted descending", fundsArr[0]?.period_return_pct >= fundsArr[fundsArr.length - 1]?.period_return_pct, true);
    await checkBool("ranking.best present", !!toolAllFunds.ranking?.best?.name, true);
  } else {
    console.log("  ⚠ skipped (fewer than 2 funds with data)");
  }

  // ── 10. Holding return for one fund ────────────────────────────────────────
  console.log("10. Holding return for fund_bluechip");
  const [holdingRow] = await query<{
    units: number; purchase_nav: number; latest_nav: number;
  }>(
    `SELECT h.units::float8, h.purchase_nav::float8,
            (SELECT nav FROM fund_nav WHERE fund_id=h.fund_id ORDER BY nav_date DESC LIMIT 1)::float8 AS latest_nav
     FROM holdings h WHERE h.fund_id='fund_bluechip'`
  );
  if (holdingRow) {
    const expectedRealised = round2(
      ((holdingRow.latest_nav - holdingRow.purchase_nav) / holdingRow.purchase_nav) * 100
    );
    const toolHolding = await runHoldingReturn({ fund: "fund_bluechip" });
    const h = toolHolding.holdings as any;
    await check("fund_bluechip realised return %", h?.realised_return_pct, expectedRealised);
  } else {
    console.log("  ⚠ skipped (no fund_bluechip holding in sample_a)");
  }

  // ── 11. Portfolio aggregate ────────────────────────────────────────────────
  console.log("11. Portfolio aggregate");
  const toolPortfolio = await runHoldingReturn({});
  const port = (toolPortfolio as any).portfolio;
  const [sqlPortfolio] = await query<{ cost: number }>(
    `SELECT SUM(h.units::float8 * h.purchase_nav::float8) AS cost FROM holdings h`
  );
  await check("portfolio total cost", port.total_cost_inr, sqlPortfolio.cost);

  // ── 12. Month-over-month food comparison ──────────────────────────────────
  console.log("12. Month-over-month food spend (Feb vs Mar 2025)");
  const toolFeb = await runQueryTransactions({ filters: { category: "food", month: "2025-02" } });
  const toolMar = await runQueryTransactions({ filters: { category: "food", month: "2025-03" } });
  const [sqlFeb] = await query<{ net: number }>(
    `SELECT COALESCE(SUM(amount),0)::float8 AS net FROM transactions
     WHERE category='food' AND txn_date>='2025-02-01' AND txn_date<='2025-02-28' AND is_transfer=FALSE`
  );
  const [sqlMar] = await query<{ net: number }>(
    `SELECT COALESCE(SUM(amount),0)::float8 AS net FROM transactions
     WHERE category='food' AND txn_date>='2025-03-01' AND txn_date<='2025-03-31' AND is_transfer=FALSE`
  );
  await check("Feb food spend matches SQL", toolFeb.summary.net_spend, sqlFeb.net);
  await check("Mar food spend matches SQL", toolMar.summary.net_spend, sqlMar.net);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  await closePool();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err.message);
  process.exit(1);
});
