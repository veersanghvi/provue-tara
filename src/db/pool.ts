import pg from "pg";
import * as dotenv from "dotenv";

dotenv.config();

// Return DATE columns (OID 1082) as raw 'YYYY-MM-DD' strings instead of JS Date
// objects. This avoids timezone shifts that would otherwise move dates by a day.
pg.types.setTypeParser(1082, (v) => v);
// Return NUMERIC (OID 1700) as JS number. Safe here: all magnitudes are far
// within IEEE-754 integer precision, and tools round to 2 dp.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and add your Postgres connection string."
  );
}

// Hosted Postgres (Neon/Supabase/Render) requires SSL. Local Postgres usually does not.
// Enable SSL automatically unless the host is localhost.
const isLocal = /@(localhost|127\.0\.0\.1)/.test(connectionString);

export const pool = new pg.Pool({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
});

/** Run a parameterized query and return rows. */
export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

/** Run a query and return the first row, or null. */
export async function queryOne<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows.length ? rows[0] : null;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
