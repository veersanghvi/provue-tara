# Design Notes

## Schema

**transactions** - one row per spending event. `amount` is signed so refunds (negative) naturally reduce totals. Two boolean columns computed at ingest time: `is_transfer` (category = 'transfer') and `is_refund` (amount < 0). Having these precomputed means the WHERE clauses stay simple and fast.

`merchant_norm` stores the brand anchor (see Merchant Matching below). Computing it once at ingest is much cheaper than doing it on every query.

**funds** - market data for each fund, independent of what the user owns.

**fund_nav** - one row per (fund_id, nav_date). Primary key on the pair. The data has 24 monthly points per fund but the schema handles any number of points.

**holdings** - what the user actually owns. Units, purchase date, purchase NAV. Foreign keys to funds. The join holdings x fund_nav drives all return calculations.

**run_logs** - one row per /ask request for observability. Stored in Postgres so it survives restarts.

### Indexes

| Table | Index | Why |
|---|---|---|
| transactions | txn_date | date range filters are the most common filter |
| transactions | category | category equality filters |
| transactions | merchant_norm | brand anchor lookup |
| transactions | (txn_date, category) | combined date + category queries |
| transactions | GIN trigram on merchant_raw, merchant_norm | fuzzy merchant search |
| funds | GIN trigram on name | partial fund name lookup |
| fund_nav | (fund_id, nav_date) PK | nearest-NAV subquery |
| holdings | fund_id | join to fund_nav |

## Merchant Matching

The main challenge is that the same merchant appears with many different strings ("Swiggy", "SWIGGY*ORDER", "Swiggy Instamart", etc). I can't hardcode brand names because the grading uses a different dataset.

The approach: strip generic noise from every merchant string and take the first meaningful token as the brand anchor. The noise list covers legal suffixes (PVT, LTD), transaction noise (ORDER, BOOKING, PAYMENT), corporate descriptors (SYSTEMS, TECHNOLOGIES), web tokens (COM, IN), and Indian geography (MUMBAI, BANGALORE, etc). None of these are ever a brand name on their own.

At query time, a search term is normalized the same way and matched with:
- exact anchor equality (fast)
- raw ILIKE substring (catches partial names)
- pg_trgm similarity > 0.45 (catches spelling variants)

Known gap: pure abbreviations like AMZ vs AMAZON don't collapse because resolving those would require a brand dictionary. The ILIKE fallback covers the case where the user types the full name.

## Formulas

**Net spend**: `SUM(amount)` excluding transfers. Negative amounts (refunds) reduce the total automatically.

**Gross spend**: `SUM(amount) FILTER (WHERE amount > 0)` - positive transactions only.

**Fund period return**: `(end_nav - start_nav) / start_nav * 100`. Uses the nearest NAV on or before each date since the series is monthly. This is market data, nothing to do with what the user paid.

**Holding realised return**: `(units * latest_nav - units * purchase_nav) / (units * purchase_nav) * 100`. This is what the user actually made based on their purchase price.

**Portfolio aggregate**: sum of (units * latest_nav) across all holdings, vs sum of (units * purchase_nav). The difference is total gain.

**Recurring detection**: a merchant is flagged as recurring if it has 3+ positive charges with an average gap between 20 and 38 days (roughly monthly with some billing date drift) and a coefficient of variation (stddev/mean) under 0.45 (stable amount). Computed from the data, no hardcoded subscription brands.

## Relative dates

The data runs Jan 2024 to Mar 2025. "Last month", "today", "current portfolio value" etc are all resolved against the latest date in the database, not the wall clock. So "today" for NAV purposes means the most recent NAV date in fund_nav.

## Tool design

Four tools. The brief said to prefer fewer expressive tools over many narrow ones and I agree - every tool definition costs tokens on every turn.

- **query_transactions** - handles all spending queries. Filter by merchant, category, date, month, quarter. Group by merchant/category/month. Works for totals, top-N, comparisons, refunds, alias lookups.
- **detect_recurring** - separate because the logic (cadence + variance analysis) is different from aggregation and the output shape is different.
- **fund_return** - fund NAV period return. Kept separate from holding_return because the grading specifically tests that the agent knows the difference.
- **holding_return** - user's realised return. Also returns the fund's period return over the same window so the agent can answer "mixed" questions comparing the two in one call.

## Grounding

Every number comes from a tool result. The system prompt explicitly forbids the agent from stating any figure it didn't retrieve. Tools return `no_data: true` when nothing matches. All arithmetic is in SQL, not in the model's response.

The smoke test (`npm run smoke`) verifies tool outputs against direct SQL on the actual database, with no model involved.

## Evals

14 questions in `scripts/eval.ts`. Each expected value is computed from the database at test time using SQL, so it works against any snapshot, not just sample_a. Covers: single lookup, date filtering, refunds, merchant aliases, transfer exclusion, month-over-month comparison, top-N merchants, recurring subscriptions, no-data case, fund period return, fund ranking, holding return, portfolio value, and the mixed fund vs holding comparison.

## Observability

Each /ask request gets a UUID. Tool calls are timed and recorded using AsyncLocalStorage so no extra plumbing is needed in the tool code. On completion, a JSONL trace file is written to logs/ and a row is inserted into run_logs. The console logs a one-liner with status, latency, tools called, and the question.

To inspect a failed run:
```bash
cat logs/trace-<request_id>.jsonl | python -m json.tool
# or
psql $DATABASE_URL -c "SELECT * FROM run_logs WHERE status='error' ORDER BY created_at DESC LIMIT 5"
```

API keys and secrets are never logged.

## Async milestone

Not implemented. All tools are synchronous database queries and complete well under a second in practice. The assignment says this is fine if documented.

If I were building this for production I'd add a job table (already have the DB) and a worker for anything that touches multiple funds, with the agent turn returning "computing..." and resuming when the job completes.

## Deployment

Railway for the app, Neon for Postgres. The ingest script runs on startup so the data is always loaded.

Railway free tier cold starts after inactivity (~30s on first request). Neon free tier can be slow after idle. Both are documented limitations.

## What could break

1. Abbreviation aliases (AMZ, ACT) don't unify. The ILIKE fallback helps but isn't perfect.
2. If the model picks the wrong tool for an unusual question, the answer might be wrong or incomplete. The system prompt has tool selection hints but the model is non-deterministic.
3. Numbers could technically be wrong if the model ignores tool results and reasons from context. The system prompt forbids this but can't guarantee it.
4. Cold start latency on Railway means the first request after idle can time out in some clients.
5. The eval suite checks that expected numbers appear in the answer text. If the model formats numbers differently (e.g. 1,234 vs 1234) the check could fail even if the answer is correct.
