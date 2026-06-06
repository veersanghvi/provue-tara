# Provue Take-Home — Tara, Finance-Research Agent

Tara is a personal finance-research persona that answers natural-language questions about spending and mutual fund holdings using tool calls backed by a real Postgres database.

## ⚠️ API Key Note

I do not currently have an active LLM API key to attach to this submission. The full agent code is wired for both **Anthropic** (`MODEL_PROVIDER=anthropic`) and **OpenAI** (`MODEL_PROVIDER=openai`). If you'd like to test it live, please set either `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment — the server and evals will work immediately.

Everything that does not require a model key has been verified:
- All 3 sample snapshots ingest cleanly (`npm run ingest`)
- All 4 tools pass the deterministic smoke test (`npm run smoke` → **14/14 passed**) — this verifies every SQL computation, merchant alias matching, fund return formula, and holding return formula against direct database queries with no model involved.

## Quick start (local)

```bash
# 1. Clone and install
git clone https://github.com/veersanghvi/provue-tara
cd provue-tara
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env:
#   DATABASE_URL=<your Neon / Supabase / local Postgres URL>
#   MODEL_PROVIDER=anthropic          # or openai
#   ANTHROPIC_API_KEY=<your key>      # or OPENAI_API_KEY=

# 3. Load a snapshot
DATA_DIR=./data/sample_a npm run ingest

# 4. Verify tools (no LLM key required)
npm run smoke            # 14/14 passed

# 5. Start the server (needs LLM key)
npm start                # http://localhost:3000

# 6. Ask a question
curl -s -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"What was my biggest expense?"}' | jq .

# 7. Run the eval suite (server must be running)
npm run eval
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string. Free Neon: https://neon.tech |
| `MODEL_PROVIDER` | ✅ | `anthropic` (default) or `openai` |
| `ANTHROPIC_API_KEY` | ✅ if anthropic | Your Anthropic key (claude-3-5-sonnet-latest) |
| `OPENAI_API_KEY` | ✅ if openai | Your OpenAI key (gpt-4o) |
| `MODEL_ID` | optional | Override the default model id |
| `PORT` | optional | HTTP port (default 3000) |
| `DATA_DIR` | ingest only | Snapshot folder to load (default `./data/sample_a`) |

> **No LLM key?** `npm run smoke` and `npm run ingest` work without one. `npm start` and `npm run eval` need a key to call the model.

## Loading different snapshots

```bash
DATA_DIR=./data/sample_b npm run ingest   # replace current data with sample_b
DATA_DIR=./data/sample_c npm run ingest   # or sample_c
# Ingest is idempotent: truncates + reloads each time.
```

## The API contract

```
POST /ask
Content-Type: application/json
{ "question": "How much did I spend on food last month?" }

→ { "answer": "You spent ₹..." }

GET /health
→ { "status": "ok", "db": "connected" }
```

## Postgres setup (local without Docker)

The fastest path is a free [Neon](https://neon.tech) account — you get a `DATABASE_URL` in under two minutes and it also serves as your deployed database.

For a local install: [postgresql.org/download](https://www.postgresql.org/download/) → create database `provue_tara` → set `DATABASE_URL=postgres://postgres:postgres@localhost:5432/provue_tara`.

## Deployment (Render)

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → New → Web Service → connect your repo.
3. Render auto-detects `render.yaml`. Set two env vars in the Render dashboard:
   - `DATABASE_URL` — your Neon connection string
   - `ANTHROPIC_API_KEY` — your Anthropic key
4. After the first deploy, open the Render shell and run:
   ```bash
   DATA_DIR=./data/sample_a npm run ingest
   ```
5. Hit `POST <render-url>/ask` to verify.

**Deployed URL:** `https://provue-tara.onrender.com` *(update once deployed)*

**Known limitations:**
- Free Render tier cold-starts after ~15 min of inactivity (~30 s first-request latency).
- Neon free tier pauses the DB after inactivity; the first query after a pause takes ~1–2 s.
- The `/ask` endpoint is synchronous; all tool calls run in-process (async milestone not implemented — see DESIGN.md).

## Project structure

```
src/
  db/
    pool.ts          Postgres connection pool + typed query helpers
    schema.sql       DDL applied by ingest (idempotent)
  lib/
    normalize.ts     Merchant brand-anchor normalization (brand-agnostic)
    dates.ts         Month / quarter / ISO date parsing
    dbHelpers.ts     Anchor dates, merchant SQL clause, round2
    trace.ts         Per-request AsyncLocalStorage observability
  tools/
    queryTransactions.ts  Workhorse: filter + aggregate transactions
    detectRecurring.ts    Recurring subscription detection
    fundReturn.ts         Fund period return (NAV-based, market data)
    holdingReturn.ts      User realised return on holdings + portfolio
    index.ts              Barrel export
  agent.ts           Tara — Mastra Agent definition
  server.ts          Express POST /ask + GET /health
scripts/
  ingest.ts          Load a snapshot folder into Postgres
  smoke.ts           Deterministic tool correctness test (no LLM)
  eval.ts            End-to-end eval suite (14 cases, needs server + key)
data/
  sample_a/  sample_b/  sample_c/    Sample snapshots (JSON, not loaded at request time)
logs/                  Per-request trace JSONL files
```
