import pg from "pg";
import * as dotenv from "dotenv";

dotenv.config();

// Return DATE columns as plain YYYY-MM-DD strings instead of JS Date objects.
// Without this, dates shift by timezone offset which breaks all date comparisons.
pg.types.setTypeParser(1082, (v) => v);
// Return NUMERIC as JS number. Values here are all currency/NAV so precision is fine.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

const isLocal = /@(localhost|127\.0\.0\.1)/.test(connectionString);

export const pool = new pg.Pool({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
});

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function queryOne<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows.length ? rows[0] : null;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
