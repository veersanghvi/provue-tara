# provue-tara

Tara is a finance research agent that answers natural language questions about spending and mutual fund holdings. Built with Mastra, Postgres, and Express.

## Note on API key

I don't have an active LLM API key to attach to this submission. The code supports both Anthropic (`MODEL_PROVIDER=anthropic`) and OpenAI (`MODEL_PROVIDER=openai`). Set whichever key you have and it works.

All the tool logic has been verified without a key - `npm run smoke` runs 14 deterministic tests that check every SQL query, merchant alias matching, fund return formula and holding return formula against the database directly. All 14 pass.

## Running locally

```bash
git clone https://github.com/veersanghvi/provue-tara
cd provue-tara
npm install

cp .env.example .env
# fill in DATABASE_URL and your LLM key

DATA_DIR=./data/sample_a npm run ingest

npm run smoke   # verify tools work, no LLM needed

npm start       # http://localhost:3000

curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"What was my biggest expense?"}'

# run evals (server needs to be running)
npm run eval
```

## Env vars

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `MODEL_PROVIDER` | `anthropic` or `openai` |
| `ANTHROPIC_API_KEY` | needed if using anthropic |
| `OPENAI_API_KEY` | needed if using openai |
| `MODEL_ID` | optional model override |
| `PORT` | defaults to 3000 |
| `DATA_DIR` | snapshot to load, used by ingest script |

## Loading a different snapshot

```bash
DATA_DIR=./data/sample_b npm run ingest
```

Ingest is idempotent - truncates and reloads every time.

## API

```
POST /ask
{ "question": "How much did I spend on food last month?" }
-> { "answer": "..." }

GET /health
-> { "status": "ok", "db": "connected" }
```

## Project structure

```
src/
  db/
    pool.ts         postgres connection + query helpers
    schema.sql      table definitions, applied at ingest time
  lib/
    normalize.ts    merchant name normalization
    dates.ts        month/quarter/date parsing
    dbHelpers.ts    shared query utilities
    trace.ts        per-request observability
  tools/
    queryTransactions.ts
    detectRecurring.ts
    fundReturn.ts
    holdingReturn.ts
    index.ts
  agent.ts          Tara agent definition
  server.ts         Express server
scripts/
  ingest.ts         load a snapshot into postgres
  smoke.ts          deterministic correctness tests (no LLM)
  eval.ts           end-to-end eval suite
data/
  sample_a/
  sample_b/
  sample_c/
```

## Deployment

Deployed on Railway: `https://provue-tara-production-0543.up.railway.app`

Uses Neon for hosted Postgres. The ingest script runs automatically on startup.

Known limitations:
- Railway free tier can have cold start latency on the first request
- Neon free tier can take a second or two after idle periods
- The /ask endpoint is synchronous (no background job queue)
