# DESIGN.md — Tara Finance-Research Agent

## Postgres Schema

### Tables and rationale

**`transactions`**
Stores one row per spending event. `amount` is signed: negative = refund/reversal. We persist two computed booleans at ingest time rather than computing them on every query:
- `is_transfer` — `category = 'transfer'`. Transfers are money moving between the user's own accounts and must not count as spending unless explicitly asked.
- `is_refund` — `amount < 0`. Keeps the WHERE clause cheap.

`merchant_norm` is the brand anchor computed by `normalize.ts` (see §Merchant Matching). Stored at ingest so tools can filter by equality, which is much faster than recomputing at query time.

**`funds`**
One row per mutual fund (market data, not user-specific). Fund id and name are both stored for flexible lookup.

**`fund_nav`**
One row per `(fund_id, nav_date)`. Primary key on the pair. 24 monthly points per fund in the sample data; the structure handles any number of points for any future snapshot.

**`holdings`**
What the user actually owns: units, purchase date, and purchase NAV. Foreign-keys to `funds`. The join `holdings × fund_nav` drives both realised-return and portfolio-value queries.

**`run_logs`**
One row per `/ask` request. Populated by the server's trace sink. Survives restarts (Postgres, not in-memory). Used for observability and debugging.

### Indexes

| Table | Index | Purpose |
|---|---|---|
| transactions | `txn_date` | Date-range filters (the most common filter) |
| transactions | `category` | Category equality filters |
| transactions | `merchant_norm` | Brand-anchor equality (collapses aliases) |
| transactions | `(txn_date, category)` | Composite for category-in-period queries |
| transactions | GIN trigram on `merchant_raw`, `merchant_norm` | Fuzzy merchant search fallback |
| funds | GIN trigram on `name` | Fund name lookup by partial match |
| fund_nav | `(fund_id, nav_date)` PK | Nearest-NAV lateral subquery |
| holdings | `fund_id` | Join to fund_nav |

---

## Formulas

### Spend / Net spend
```
net_spend = SUM(amount)  [negative amounts reduce it]
```
Transfers excluded by default (`is_transfer = FALSE`). Refunds are included (they reduce the total), which is the correct behaviour for "how much did I spend on X after refunds".

### Gross spend (positive only)
```
gross_spend = SUM(amount) FILTER (WHERE amount > 0)
```

### Fund period return
```
period_return_pct = (end_nav - start_nav) / start_nav × 100
```
Where `start_nav` is the nearest NAV on or **before** `date_from`, and `end_nav` is the nearest NAV on or before `date_to`. The NAV series is monthly; "nearest on or before" handles any requested date.

This is **market data** and is independent of the user's holdings.

### Holding realised return
```
cost           = units × purchase_nav
current_value  = units × latest_nav          (latest_nav = max(nav_date) in fund_nav)
absolute_return_inr = current_value - cost
realised_return_pct = (current_value - cost) / cost × 100
```
This is the **user-specific** return based on their actual purchase price.

### Portfolio aggregate
```
total_cost  = Σ (units_i × purchase_nav_i)
total_value = Σ (units_i × latest_nav_i)
total_gain  = total_value - total_cost
portfolio_return_pct = total_gain / total_cost × 100
```

### Fund period return over the holding window (for "mixed" questions)
Same formula as fund period return, with `date_from = purchase_date` and `date_to = latest_nav_date`. Returned alongside the holding return so the agent can explicitly contrast "my return on this fund" vs "what the fund did over the same period".

### Recurring subscription detection
A merchant is flagged as recurring if:
- It has ≥ 3 positive charges that are not transfers.
- The average gap between consecutive charges is between 20 and 38 days (roughly monthly, tolerating billing-date drift).
- The coefficient of variation of the charge amount (stddev / mean) is ≤ 0.45 (stable price).

This is computed purely from the data — no hardcoded subscription brand list.

---

## Merchant Matching

### At ingest (`normalize.ts`)
Every `merchant_raw` is normalised to a `merchant_norm` brand anchor:
1. Uppercase.
2. Replace `* / . - _ , @ &` with spaces.
3. Drop non-alphanumeric characters.
4. Tokenize by whitespace.
5. Remove generic stopwords: legal suffixes (PVT, LTD, LIMITED, INC, LLP…), payment-rail noise (ORDER, BOOKING, PAYMENT, TXN…), corporate descriptors (SYSTEMS, TECHNOLOGIES, SOLUTIONS…), web tokens (COM, IN, WWW…), and generic Indian geography (MUMBAI, BANGALORE, DELHI…).
6. First surviving token = brand anchor.

This collapses `Swiggy`, `Swiggy Instamart`, `SWIGGY*ORDER`, `SWIGGY BANGALORE` → `SWIGGY` without any hardcoded brand list.

### At query time (`dbHelpers.ts#merchantClause`)
A search term is normalised the same way, then matched using:
```sql
merchant_norm = <anchor>
OR merchant_raw ILIKE '%<term>%'
OR similarity(merchant_norm, <anchor>) > 0.45
```
This covers exact anchor match, partial raw match, and minor spelling variants via pg_trgm similarity.

**Known limitation:** Pure abbreviation pairs (e.g. `AMZ` ↔ `AMAZON`, `ACT` ↔ `ATRIA CONVERGENCE`) do not collapse, because unifying them requires a brand dictionary. The query-time ILIKE fallback partially covers cases where the user types the full name. This is an acknowledged tradeoff: a brand dictionary would fail on the unseen 4th snapshot.

---

## Relative-date Policy

The dataset is historical (transactions Jan 2024–Mar 2025; NAVs Apr 2023–Mar 2025). Wall-clock "today" is meaningless against this data.

- **Spending questions**: "last month", "March", bare month names, "today" → resolved against `MAX(txn_date)` in the database. Example: if the latest transaction is 2025-03-30, "last month" = February 2025.
- **Portfolio / NAV questions**: "today", "current value", "latest NAV" → resolved against `MAX(nav_date)` in `fund_nav`.
- **Explicit dates / ranges**: used as-given.
- **Relative quarters**: Q1 2025 = 2025-01-01 to 2025-03-31.

All anchor dates are read from the database at query time so they automatically reflect whatever snapshot is loaded.

---

## Tool Design

Four tools, chosen to be few and expressive as the brief specifies.

| Tool | Purpose | Why not split further |
|---|---|---|
| `query_transactions` | All spending queries: filter by merchant/category/date, aggregate by group_by dimension, top-N | One expressive tool beats four narrow ones for both token budget and selection accuracy. The `group_by` + `metric` parameters carry the specificity. |
| `detect_recurring` | Subscription / recurring merchant detection | Separate because the logic (cadence + variance analysis) is distinct from spending aggregation and the output shape differs. |
| `fund_return` | Fund NAV period return (market data) | Separate from `holding_return` because the graders explicitly test that the agent understands the distinction. Conflating them would produce wrong answers. |
| `holding_return` | User's realised return on holdings + portfolio | Same reason. Also returns `fund_period_return_pct_same_window` alongside so the agent can answer "mixed" questions in one tool call. |

---

## Grounding Guarantee

Every number in Tara's answer comes from a tool result:
1. The system prompt explicitly forbids Tara from stating any figure not retrieved by a tool.
2. Tools return `no_data: true` when the database returns no rows; Tara's instructions require honest disclosure in that case.
3. All arithmetic (sums, averages, returns, rankings) is computed in SQL by the tool, not by the model from raw rows.
4. The deterministic smoke test (`npm run smoke`) runs on every snapshot to verify that tool numbers match direct SQL — no model involved.

---

## Evals

14 questions in `scripts/eval.ts`, covering:
- Single lookup (biggest expense)
- Date filtering (food March 2025)
- Refunds (net vs gross)
- Merchant aliases (Swiggy variants)
- Transfer exclusion (Q1 actual spend)
- Month-over-month category comparison
- Top-N merchants
- Recurring subscriptions
- No-data case (rent April 2025)
- Fund period return
- All-fund ranking + spread
- Realised holding return (specific fund)
- Portfolio aggregate value
- Mixed fund-vs-holding comparison

Each expected value is computed live from the database via SQL, so the eval works against any snapshot loaded at test time — not just sample_a.

---

## Observability

Per request, the server:
1. Generates a `request_id` (UUID).
2. Uses `AsyncLocalStorage` to thread trace state through all tool calls without changing tool signatures.
3. Each tool call records: tool name, sanitized input, tables read, latency, success/error.
4. On completion, writes a `.jsonl` trace file to `logs/trace-<request_id>.jsonl`.
5. Inserts a `run_logs` row into Postgres (persists across restarts; useful for post-mortem).
6. Logs a one-liner to stdout: status, request_id, latency, tools called, question prefix.

To inspect a failed run:
```bash
cat logs/trace-<request_id>.jsonl | jq .
# or
psql $DATABASE_URL -c "SELECT * FROM run_logs WHERE status='error' ORDER BY created_at DESC LIMIT 5"
```

Secrets (API keys, passwords) are never logged. The `sanitizeInput` function strips any key matching `/key|token|secret|password|auth|credential/i`.

---

## Async Tool Milestone

Not implemented. All tools run synchronously in the Express request handler. Decision rationale:
- The tools are pure database queries with sub-second latency in practice.
- The assignment states this milestone is optional and that synchronous is acceptable if documented.
- Retrofitting an async job queue (BullMQ + job table + webhook or polling) after the fact would require changing the `/ask` contract or adding a polling endpoint, both of which risk introducing new failure modes under the deadline.

In production I would implement it for the portfolio holdings query (which could involve many funds) using a jobs table in Postgres (already there) and a BullMQ worker, with the agent's turn ending with "computing…" and resuming via a synthetic `<async_tool_completion>` message once the worker posts its result.

---

## Deployment

- **App host:** Render free web service (Oregon).
- **Database:** Neon free tier (serverless Postgres, always-on via pooler).
- **Cold-start:** Render free tier sleeps after ~15 min inactivity; first request takes ~30 s.
- **Neon:** The pooler endpoint is used (`-pooler.` in the URL), which handles connection multiplexing well on serverless.
- **Ingest on deploy:** Run once via Render Shell: `DATA_DIR=./data/sample_a npm run ingest`. For the grader's hidden snapshot, run with `DATA_DIR=./data/sample_x npm run ingest`.

---

## Failure Modes and What I'd Do With More Time

| Failure mode | Current handling | Improvement |
|---|---|---|
| Abbreviation aliases (AMZ ↔ AMAZON) | ILIKE partial fallback; documented limitation | A lightweight edit-distance check at ingest to cluster merchant_norm variants, or an LLM-assisted canonicalization pass at ingest time (one-time cost) |
| Model selects the wrong tool | System prompt tool selection guide; Zod validation rejects bad inputs | Fine-tuned tool descriptions; few-shot examples in system prompt |
| Model hallucinates a number despite instructions | System prompt + `no_data` flag; eval suite catches regressions | Structured output validation: parse the answer for numbers and cross-check against tool results |
| Long-running portfolio query blocking the event loop | Sub-second in practice for 8 holdings | Async milestone (BullMQ + jobs table) for >N holdings |
| Neon cold-start adds latency | Documented in README | Upgrade to paid tier or pre-warm with a cron ping |
| Tool called with malformed date string | `asISODate` returns null; query falls back to no date filter | Return a validation error to the agent so it can self-correct |
