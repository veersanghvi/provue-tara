import * as dotenv from "dotenv";
dotenv.config();

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import { pool, query } from "./db/pool.js";
import { createTaraAgent } from "./agent.js";
import { runWithTrace, type TraceContext } from "./lib/trace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, "../logs");
mkdirSync(LOGS_DIR, { recursive: true });

const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json());

app.get("/health", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch (err: any) {
    res.status(503).json({ status: "error", db: err.message });
  }
});

app.post("/ask", async (req: Request, res: Response, next: NextFunction) => {
  const startMs = Date.now();
  const requestId = randomUUID();
  const { question } = req.body ?? {};

  if (!question || typeof question !== "string" || !question.trim()) {
    res.status(400).json({ error: "Request body must include a non-empty 'question' string." });
    return;
  }

  const traceCtx: TraceContext = {
    request_id: requestId,
    question: question.trim(),
    tool_calls: [],
  };

  try {
    const agent = createTaraAgent();
    const answer = await runWithTrace(traceCtx, async () => {
      const result = await agent.generate(question.trim());
      return result.text;
    });

    const latencyMs = Date.now() - startMs;
    await persistTrace(traceCtx, latencyMs, "success", null);
    res.json({ answer });
  } catch (err: any) {
    const latencyMs = Date.now() - startMs;
    await persistTrace(traceCtx, latencyMs, "error", err?.message ?? String(err));
    next(err);
  }
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[server] error:", err?.message ?? err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Something went wrong. Check logs for details." });
  }
});

async function persistTrace(
  ctx: TraceContext,
  latencyMs: number,
  status: "success" | "error",
  error: string | null
) {
  const tablesRead = [...new Set(ctx.tool_calls.flatMap((t) => t.tables_read))];
  const sanitizedInputs = ctx.tool_calls.map((t) => ({
    tool: t.tool,
    input: sanitizeInput(t.input),
  }));

  const record = {
    request_id: ctx.request_id,
    question: ctx.question,
    tools_called: ctx.tool_calls.map((t) => t.tool),
    tool_inputs: sanitizedInputs,
    tables_read: tablesRead,
    latency_ms: latencyMs,
    status,
    error,
    created_at: new Date().toISOString(),
  };

  try {
    appendFileSync(join(LOGS_DIR, `trace-${ctx.request_id}.jsonl`), JSON.stringify(record) + "\n");
  } catch {
    // non-fatal
  }

  try {
    await query(
      `INSERT INTO run_logs (request_id, question, tools_called, tool_inputs, tables_read, latency_ms, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        ctx.request_id,
        ctx.question,
        JSON.stringify(record.tools_called),
        JSON.stringify(sanitizedInputs),
        tablesRead,
        latencyMs,
        status,
        error,
      ]
    );
  } catch {
    // non-fatal
  }

  console.log(`[${status}] ${ctx.request_id} | ${latencyMs}ms | tools: [${record.tools_called.join(", ")}] | "${ctx.question.slice(0, 80)}"`);
  if (error) console.error(`[error] ${ctx.request_id}: ${error}`);
}

function sanitizeInput(input: any): any {
  if (!input || typeof input !== "object") return input;
  const blocked = /key|token|secret|password|auth|credential/i;
  return Object.fromEntries(Object.entries(input).filter(([k]) => !blocked.test(k)));
}

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`Tara running on port ${PORT}`);
});

export default app;
