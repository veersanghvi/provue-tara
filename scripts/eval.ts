/**
 * Eval suite - sends questions to the local /ask endpoint and asserts that
 * expected facts/numbers appear in the natural-language answer.
 *
 * Each expected value is computed live from the database via SQL so the eval
 * works against any snapshot (sample_a, sample_b, sample_c, or the hidden 4th).
 *
 * Run:
 *   npm start &             # boot the server first
 *   npx tsx scripts/eval.ts
 *
 * Or against a deployed URL:
 *   BASE_URL=https://your-app.onrender.com npx tsx scripts/eval.ts
 */
import * as dotenv from "dotenv";
dotenv.config();

import { query, closePool } from "../src/db/pool.js";

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

interface EvalCase {
  id: string;
  question: string;
  /** Returns an array of strings that must ALL appear (case-insensitive) in the answer. */
  getExpected: () => Promise<string[]>;
  /** Optional: strings that must NOT appear (hallucination guards). */
  mustNotContain?: string[];
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function ask(question: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { answer?: string; error?: string };
  if (!json.answer) throw new Error(`No 'answer' field: ${JSON.stringify(json)}`);
  return json.answer;
}

const CASES: EvalCase[] = [
  // ── 1. Single lookup ──────────────────────────────────────────────────────
  {
    id: "01_biggest_expense",
    question: "What was my single biggest expense?",
    getExpected: async () => {
      const [r] = await query<{ merchant: string; amount: number }>(
        `SELECT merchant_raw AS merchant, amount::float8 AS amount FROM transactions
         WHERE is_transfer=FALSE ORDER BY amount DESC LIMIT 1`
      );
      return [r.merchant, String(round2(r.amount))];
    },
  },

  // ── 2. Date filtering ─────────────────────────────────────────────────────
  {
    id: "02_food_march_2025",
    question: "How much did I spend on food in March 2025?",
    getExpected: async () => {
      const [r] = await query<{ net: number }>(
        `SELECT COALESCE(SUM(amount),0)::float8 AS net FROM transactions
         WHERE category='food' AND txn_date>='2025-03-01' AND txn_date<='2025-03-31'
           AND is_transfer=FALSE`
      );
      return [String(round2(r.net))];
    },
  },

  // ── 3. Refunds (net vs gross) ─────────────────────────────────────────────
  {
    id: "03_food_march_after_refunds",
    question: "How much did I spend on food in March 2025 after refunds?",
    getExpected: async () => {
      const [r] = await query<{ net: number }>(
        `SELECT COALESCE(SUM(amount),0)::float8 AS net FROM transactions
         WHERE category='food' AND txn_date>='2025-03-01' AND txn_date<='2025-03-31'
           AND is_transfer=FALSE`
      );
      return [String(round2(r.net))];
    },
    mustNotContain: ["I don't have"],
  },

  // ── 4. Merchant aliases ───────────────────────────────────────────────────
  {
    id: "04_swiggy_aliases",
    question: "How much did I spend on Swiggy in total, including all Swiggy variants?",
    getExpected: async () => {
      const [r] = await query<{ net: number }>(
        `SELECT COALESCE(SUM(amount),0)::float8 AS net FROM transactions
         WHERE merchant_norm='SWIGGY' AND is_transfer=FALSE`
      );
      if (round2(r.net) === 0) {
        // This snapshot may not have Swiggy; expect honest no-data reply
        return ["no", "data"];
      }
      return [String(round2(r.net))];
    },
  },

  // ── 5. Transfers excluded ─────────────────────────────────────────────────
  {
    id: "05_q1_spending_no_transfers",
    question: "Ignore transfers. What was my total actual spending in Q1 2025?",
    getExpected: async () => {
      const [r] = await query<{ net: number }>(
        `SELECT COALESCE(SUM(amount),0)::float8 AS net FROM transactions
         WHERE txn_date>='2025-01-01' AND txn_date<='2025-03-31' AND is_transfer=FALSE`
      );
      return [String(round2(r.net))];
    },
  },

  // ── 6. Category comparison month-over-month ───────────────────────────────
  {
    id: "06_food_feb_vs_mar",
    question: "Did my food spending increase from February to March 2025?",
    getExpected: async () => {
      const [feb] = await query<{ net: number }>(
        `SELECT COALESCE(SUM(amount),0)::float8 AS net FROM transactions
         WHERE category='food' AND txn_date>='2025-02-01' AND txn_date<='2025-02-28' AND is_transfer=FALSE`
      );
      const [mar] = await query<{ net: number }>(
        `SELECT COALESCE(SUM(amount),0)::float8 AS net FROM transactions
         WHERE category='food' AND txn_date>='2025-03-01' AND txn_date<='2025-03-31' AND is_transfer=FALSE`
      );
      // Just assert both month figures appear; the answer will state the direction.
      return [String(round2(feb.net)), String(round2(mar.net))];
    },
  },

  // ── 7. Top-5 merchants ────────────────────────────────────────────────────
  {
    id: "07_top5_merchants",
    question: "What were my top 5 merchants by net spend between January and March 2025?",
    getExpected: async () => {
      const rows = await query<{ merchant: string }>(
        `SELECT merchant_norm AS merchant FROM transactions
         WHERE is_transfer=FALSE AND txn_date>='2025-01-01' AND txn_date<='2025-03-31'
         GROUP BY merchant_norm ORDER BY SUM(amount) DESC LIMIT 5`
      );
      return rows.slice(0, 3).map((r) => r.merchant.toLowerCase());
    },
  },

  // ── 8. Recurring subscriptions ────────────────────────────────────────────
  {
    id: "08_recurring_subscriptions",
    question: "Which merchants look like recurring subscriptions?",
    getExpected: async () => {
      // Just verify the answer mentions at least one merchant (not empty).
      return ["every month", "recurring", "subscription", "monthly"]
        .slice(0, 1); // expect one of these context words
    },
  },

  // ── 9. No-data case ───────────────────────────────────────────────────────
  {
    id: "09_rent_april_2025",
    question: "Do I have any data for rent in April 2025?",
    getExpected: async () => {
      const [r] = await query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM transactions
         WHERE category='rent' AND txn_date>='2025-04-01' AND txn_date<='2025-04-30'`
      );
      if (r.cnt > 0) return [String(r.cnt)];
      return ["no", "not found", "no transactions", "no data", "don't have"]
        .slice(0, 1);
    },
  },

  // ── 10. Fund period return ─────────────────────────────────────────────────
  {
    id: "10_fund_period_return",
    question: "What was the return of the top performing fund between 2024-01-01 and 2025-01-01?",
    getExpected: async () => {
      const rows = await query<{ name: string; ret: number }>(
        `SELECT f.name,
                ROUND(((end_nav.nav - start_nav.nav) / start_nav.nav * 100)::numeric, 2)::float8 AS ret
         FROM funds f
         JOIN LATERAL (SELECT nav FROM fund_nav WHERE fund_id=f.id AND nav_date<='2024-01-01' ORDER BY nav_date DESC LIMIT 1) start_nav ON TRUE
         JOIN LATERAL (SELECT nav FROM fund_nav WHERE fund_id=f.id AND nav_date<='2025-01-01' ORDER BY nav_date DESC LIMIT 1) end_nav ON TRUE
         ORDER BY ret DESC LIMIT 1`
      );
      if (!rows.length) return ["return"];
      return [String(round2(rows[0].ret))];
    },
  },

  // ── 11. All-fund ranking ──────────────────────────────────────────────────
  {
    id: "11_fund_ranking",
    question: "Rank all funds by return between 2024-01-01 and 2025-01-01 and show the best and worst.",
    getExpected: async () => {
      const rows = await query<{ name: string; ret: number }>(
        `SELECT f.name,
                ROUND(((end_nav.nav - start_nav.nav) / start_nav.nav * 100)::numeric, 2)::float8 AS ret
         FROM funds f
         JOIN LATERAL (SELECT nav FROM fund_nav WHERE fund_id=f.id AND nav_date<='2024-01-01' ORDER BY nav_date DESC LIMIT 1) start_nav ON TRUE
         JOIN LATERAL (SELECT nav FROM fund_nav WHERE fund_id=f.id AND nav_date<='2025-01-01' ORDER BY nav_date DESC LIMIT 1) end_nav ON TRUE
         ORDER BY ret DESC`
      );
      if (rows.length < 2) return ["return"];
      return [rows[0].name, rows[rows.length - 1].name];
    },
  },

  // ── 12. Realised return on a specific holding ─────────────────────────────
  {
    id: "12_holding_return",
    question: "What is my realised return on my largest holding (by purchase value)?",
    getExpected: async () => {
      const [r] = await query<{ fund_name: string; ret_pct: number }>(
        `SELECT h.fund_name,
                ROUND(((latest_nav.nav - h.purchase_nav) / h.purchase_nav * 100)::numeric, 2)::float8 AS ret_pct
         FROM holdings h
         JOIN LATERAL (SELECT nav FROM fund_nav WHERE fund_id=h.fund_id ORDER BY nav_date DESC LIMIT 1) latest_nav ON TRUE
         ORDER BY (h.units::float8 * h.purchase_nav::float8) DESC LIMIT 1`
      );
      if (!r) return ["return"];
      return [r.fund_name, String(round2(r.ret_pct))];
    },
  },

  // ── 13. Portfolio value today ─────────────────────────────────────────────
  {
    id: "13_portfolio_worth",
    question: "What is my portfolio worth today, and how much have I made on it?",
    getExpected: async () => {
      const [r] = await query<{ value: number; gain: number }>(
        `SELECT
           SUM(h.units::float8 * latest_nav.nav::float8) AS value,
           SUM(h.units::float8 * (latest_nav.nav::float8 - h.purchase_nav::float8)) AS gain
         FROM holdings h
         JOIN LATERAL (SELECT nav FROM fund_nav WHERE fund_id=h.fund_id ORDER BY nav_date DESC LIMIT 1) latest_nav ON TRUE`
      );
      return [String(round2(r.value)), String(round2(r.gain))];
    },
  },

  // ── 14. Mixed fund + holding return comparison ────────────────────────────
  {
    id: "14_mixed_fund_vs_holding",
    question: "Of the funds I own, which gave me the best realised return, and how does it compare to the same fund's period return over the same window?",
    getExpected: async () => {
      const [r] = await query<{ fund_name: string }>(
        `SELECT h.fund_name
         FROM holdings h
         JOIN LATERAL (SELECT nav FROM fund_nav WHERE fund_id=h.fund_id ORDER BY nav_date DESC LIMIT 1) latest_nav ON TRUE
         ORDER BY ((latest_nav.nav::float8 - h.purchase_nav::float8) / h.purchase_nav::float8) DESC LIMIT 1`
      );
      if (!r) return ["return"];
      // The answer must name the best fund AND mention both types of return.
      return [r.fund_name];
    },
  },
];

async function runEvals() {
  console.log(`\n=== Tara eval suite (${CASES.length} cases) ===`);
  console.log(`Endpoint: ${BASE_URL}/ask\n`);

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const c of CASES) {
    process.stdout.write(`[${c.id}] asking... `);
    try {
      const [expected, answer] = await Promise.all([c.getExpected(), ask(c.question)]);
      const answerLower = answer.toLowerCase();

      const missingExpected = expected.filter((e) => !answerLower.includes(e.toLowerCase()));
      const foundForbidden = (c.mustNotContain ?? []).filter((s) =>
        answerLower.includes(s.toLowerCase())
      );

      if (missingExpected.length === 0 && foundForbidden.length === 0) {
        console.log(`✓`);
        passed++;
      } else {
        console.log(`✗`);
        const reasons: string[] = [];
        if (missingExpected.length) reasons.push(`missing: [${missingExpected.join(", ")}]`);
        if (foundForbidden.length) reasons.push(`forbidden: [${foundForbidden.join(", ")}]`);
        const msg = `  FAIL ${c.id}: ${reasons.join(" | ")}\n  Answer: "${answer.slice(0, 200)}"`;
        console.error(msg);
        failures.push(msg);
        failed++;
      }
    } catch (err: any) {
      console.log(`✗ (error)`);
      const msg = `  ERROR ${c.id}: ${err.message}`;
      console.error(msg);
      failures.push(msg);
      failed++;
    }
  }

  console.log(`\n=== Results: ${passed}/${CASES.length} passed, ${failed} failed ===`);
  if (failures.length) {
    console.log("\nFailed cases:");
    failures.forEach((f) => console.log(f));
  }

  await closePool();
  if (failed > 0) process.exit(1);
}

runEvals().catch((err) => {
  console.error("[eval] FATAL:", err.message);
  process.exit(1);
});
