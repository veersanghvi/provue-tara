-- Provue Tara — Postgres schema.
-- Applied idempotently by scripts/ingest.ts before every load.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- transactions: 15 months of personal spending.
-- amount is SIGNED: negative = refund/reversal. category 'transfer' = self-transfer.
-- merchant_norm is the brand anchor computed at ingest (see src/lib/normalize.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,
  txn_date      DATE NOT NULL,
  merchant_raw  TEXT NOT NULL,
  merchant_norm TEXT NOT NULL,
  category      TEXT NOT NULL,
  amount        NUMERIC(14, 2) NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'INR',
  memo          TEXT,
  is_transfer   BOOLEAN NOT NULL DEFAULT FALSE,
  is_refund     BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_txn_date          ON transactions (txn_date);
CREATE INDEX IF NOT EXISTS idx_txn_category      ON transactions (category);
CREATE INDEX IF NOT EXISTS idx_txn_merchant_norm ON transactions (merchant_norm);
CREATE INDEX IF NOT EXISTS idx_txn_date_category ON transactions (txn_date, category);
CREATE INDEX IF NOT EXISTS idx_txn_merchant_trgm ON transactions USING gin (merchant_raw gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_txn_norm_trgm     ON transactions USING gin (merchant_norm gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- funds: market data (independent of who owns them).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS funds (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  category TEXT
);

CREATE INDEX IF NOT EXISTS idx_funds_name_trgm ON funds USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- fund_nav: one row per (fund_id, date) NAV point.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fund_nav (
  fund_id  TEXT NOT NULL REFERENCES funds (id) ON DELETE CASCADE,
  nav_date DATE NOT NULL,
  nav      NUMERIC(14, 4) NOT NULL,
  PRIMARY KEY (fund_id, nav_date)
);

CREATE INDEX IF NOT EXISTS idx_nav_fund_date ON fund_nav (fund_id, nav_date);

-- ---------------------------------------------------------------------------
-- holdings: what the user actually owns. Joins funds on fund_id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holdings (
  id            SERIAL PRIMARY KEY,
  fund_id       TEXT NOT NULL REFERENCES funds (id) ON DELETE CASCADE,
  fund_name     TEXT NOT NULL,
  units         NUMERIC(18, 4) NOT NULL,
  purchase_date DATE NOT NULL,
  purchase_nav  NUMERIC(14, 4) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_holdings_fund ON holdings (fund_id);

-- ---------------------------------------------------------------------------
-- run_logs: observability. One row per /ask request.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_logs (
  request_id   TEXT PRIMARY KEY,
  question     TEXT NOT NULL,
  intent       TEXT,
  tools_called JSONB,
  tool_inputs  JSONB,
  tables_read  TEXT[],
  latency_ms   INTEGER,
  status       TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
