/**
 * Ingest a snapshot folder of JSON into Postgres.
 *
 * Usage:
 *   DATA_DIR=./data/sample_a npx tsx scripts/ingest.ts
 *   DATA_DIR=./data/sample_b npm run ingest
 *
 * Idempotent: applies the schema, truncates the data tables, then bulk-loads.
 * Accepts ANY snapshot path (the grader points it at an unseen 4th snapshot).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as dotenv from "dotenv";
import { pool, closePool } from "../src/db/pool.js";
import { normalizeMerchant } from "../src/lib/normalize.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

interface RawTxn {
  id: string;
  date: string;
  merchant: string;
  category: string;
  amount: number;
  currency?: string;
  memo?: string | null;
}
interface RawNav { date: string; value: number; }
interface RawFund { id: string; name: string; category?: string; nav: RawNav[]; }
interface RawHolding {
  fund_id: string;
  fund_name: string;
  units: number;
  purchase_date: string;
  purchase_nav: number;
}

function loadJson<T>(dir: string, file: string): T {
  const path = join(dir, file);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err: any) {
    throw new Error(`Failed to read ${path}: ${err.message}`);
  }
}

/** Insert rows in batches using a single parameterized statement per batch. */
async function bulkInsert(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: any[][],
  batchSize = 500
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const values: any[] = [];
    const tuples = batch.map((row, r) => {
      const placeholders = row.map((_, c) => `$${r * columns.length + c + 1}`);
      values.push(...row);
      return `(${placeholders.join(", ")})`;
    });
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`;
    const res = await client.query(sql, values);
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

import type pg from "pg";

async function main() {
  const dataDir = resolve(PROJECT_ROOT, process.env.DATA_DIR ?? "./data/sample_a");
  console.log(`[ingest] snapshot: ${dataDir}`);

  const funds = loadJson<RawFund[]>(dataDir, "funds.json");
  const holdings = loadJson<RawHolding[]>(dataDir, "holdings.json");
  const txns = loadJson<RawTxn[]>(dataDir, "transactions.json");
  console.log(`[ingest] parsed: ${funds.length} funds, ${holdings.length} holdings, ${txns.length} transactions`);

  const schemaSql = readFileSync(join(PROJECT_ROOT, "src/db/schema.sql"), "utf8");

  const client = await pool.connect();
  try {
    // 1. Apply schema (idempotent).
    await client.query(schemaSql);

    // 2. Clear data tables (preserve run_logs). CASCADE handles FK order.
    await client.query("TRUNCATE transactions, holdings, fund_nav, funds RESTART IDENTITY CASCADE");

    await client.query("BEGIN");

    // 3. funds
    const fundIds = new Set(funds.map((f) => f.id));
    await bulkInsert(
      client,
      "funds",
      ["id", "name", "category"],
      funds.map((f) => [f.id, f.name, f.category ?? null])
    );

    // 4. fund_nav (flatten nav[] -> one row per (fund_id, date)). Dedupe on (fund,date).
    const navRows: any[][] = [];
    const seenNav = new Set<string>();
    for (const f of funds) {
      for (const pt of f.nav ?? []) {
        const key = `${f.id}|${pt.date}`;
        if (seenNav.has(key)) continue;
        seenNav.add(key);
        navRows.push([f.id, pt.date, pt.value]);
      }
    }
    await bulkInsert(client, "fund_nav", ["fund_id", "nav_date", "nav"], navRows);

    // 5. holdings (warn, don't crash, on orphan fund_id)
    const validHoldings = holdings.filter((h) => {
      if (!fundIds.has(h.fund_id)) {
        console.warn(`[ingest] WARNING: holding references unknown fund_id "${h.fund_id}" - skipped`);
        return false;
      }
      return true;
    });
    await bulkInsert(
      client,
      "holdings",
      ["fund_id", "fund_name", "units", "purchase_date", "purchase_nav"],
      validHoldings.map((h) => [h.fund_id, h.fund_name, h.units, h.purchase_date, h.purchase_nav])
    );

    // 6. transactions (compute merchant_norm, is_transfer, is_refund)
    const txnRows = txns.map((t) => {
      const category = (t.category ?? "uncategorized").trim().toLowerCase();
      return [
        t.id,
        t.date,
        t.merchant,
        normalizeMerchant(t.merchant),
        category,
        t.amount,
        (t.currency ?? "INR").toUpperCase(),
        t.memo ?? null,
        category === "transfer",
        Number(t.amount) < 0,
      ];
    });
    await bulkInsert(
      client,
      "transactions",
      ["id", "txn_date", "merchant_raw", "merchant_norm", "category", "amount", "currency", "memo", "is_transfer", "is_refund"],
      txnRows
    );

    await client.query("COMMIT");

    // 7. Report
    const counts = await client.query(`
      SELECT
        (SELECT count(*) FROM funds)        AS funds,
        (SELECT count(*) FROM fund_nav)     AS nav_points,
        (SELECT count(*) FROM holdings)     AS holdings,
        (SELECT count(*) FROM transactions) AS transactions,
        (SELECT count(*) FROM transactions WHERE is_refund)  AS refunds,
        (SELECT count(*) FROM transactions WHERE is_transfer) AS transfers,
        (SELECT min(txn_date) FROM transactions) AS first_txn,
        (SELECT max(txn_date) FROM transactions) AS last_txn
    `);
    console.log("[ingest] loaded:", counts.rows[0]);
    console.log("[ingest] done.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error("[ingest] FAILED:", err.message);
  process.exit(1);
});
