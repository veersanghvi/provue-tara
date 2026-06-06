export { queryTransactionsTool } from "./queryTransactions.js";
export { detectRecurringTool } from "./detectRecurring.js";
export { fundReturnTool } from "./fundReturn.js";
export { holdingReturnTool } from "./holdingReturn.js";

import { queryTransactionsTool } from "./queryTransactions.js";
import { detectRecurringTool } from "./detectRecurring.js";
import { fundReturnTool } from "./fundReturn.js";
import { holdingReturnTool } from "./holdingReturn.js";

export const ALL_TOOLS = {
  query_transactions: queryTransactionsTool,
  detect_recurring: detectRecurringTool,
  fund_return: fundReturnTool,
  holding_return: holdingReturnTool,
} as const;
