import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolCallRecord {
  tool: string;
  input: any; // sanitized (tool inputs only — never secrets)
  tables_read: string[];
  latency_ms: number;
  ok: boolean;
  error?: string;
}

export interface TraceContext {
  request_id: string;
  question: string;
  tool_calls: ToolCallRecord[];
}

const storage = new AsyncLocalStorage<TraceContext>();

export function runWithTrace<T>(ctx: TraceContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * Wrap a tool's work so every invocation is timed and recorded into the active
 * request trace (if any). Tools call this; it is a no-op outside a request
 * (e.g. in the deterministic smoke test), so the same code path is reused.
 */
export async function traceTool<T>(
  tool: string,
  tablesRead: string[],
  input: any,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  const ctx = storage.getStore();
  try {
    const result = await fn();
    ctx?.tool_calls.push({
      tool,
      input,
      tables_read: tablesRead,
      latency_ms: Date.now() - start,
      ok: true,
    });
    return result;
  } catch (err: any) {
    ctx?.tool_calls.push({
      tool,
      input,
      tables_read: tablesRead,
      latency_ms: Date.now() - start,
      ok: false,
      error: err?.message ?? String(err),
    });
    throw err;
  }
}
