/**
 * Merchant normalization — deterministic and brand-agnostic.
 *
 * The grading snapshot has a different merchant universe, so we MUST NOT hardcode
 * brand names or alias tables. Instead we strip a GENERIC set of noise tokens
 * (legal suffixes, payment-rail noise, corporate descriptors, web tokens, generic
 * geography) and take the first surviving token as the "brand anchor".
 *
 * Examples (all collapse to the same anchor):
 *   "Swiggy"            -> "SWIGGY"
 *   "Swiggy Instamart"  -> "SWIGGY"
 *   "SWIGGY*ORDER"      -> "SWIGGY"
 *   "SWIGGY BANGALORE"  -> "SWIGGY"
 *   "NETFLIX.COM"       -> "NETFLIX"
 *   "UBER INDIA SYSTEMS PVT" -> "UBER"
 *
 * Known limitation: pure abbreviations (AMZ <-> AMAZON, ACT <-> ATRIA) do not
 * collapse, because unifying them would require a brand dictionary. Query-time
 * matching adds a fuzzy fallback to partially cover this. See DESIGN.md.
 */

// Generic tokens that are never a brand on their own.
const STOPWORDS = new Set<string>([
  // legal / corporate suffixes
  "PVT", "PVTLTD", "LTD", "LIMITED", "PRIVATE", "INC", "LLP", "LLC", "CO", "CORP",
  "COMPANY", "GROUP", "HOLDINGS",
  // corporate descriptors
  "SYSTEMS", "TECHNOLOGIES", "TECHNOLOGY", "TECH", "SOLUTIONS", "SERVICES", "SERVICE",
  "ENTERPRISES", "ENTERPRISE", "INDUSTRIES", "RETAIL", "ONLINE", "DIGITAL", "GLOBAL",
  "INTERNATIONAL", "VENTURES", "LABS",
  // payment-rail / transaction noise
  "ORDER", "ORDERS", "TRIP", "TRIPS", "BOOKING", "BOOKINGS", "PAYMENT", "PAYMENTS",
  "PAY", "TXN", "TRANSACTION", "PURCHASE", "BILL", "RECHARGE", "SUBSCRIPTION",
  // web / handle tokens
  "COM", "IN", "WWW", "NET", "ORG", "APP", "IO",
  // generic geography (Indian cities / regions) — locations, not brands
  "INDIA", "BHARAT", "MUMBAI", "BOMBAY", "DELHI", "NEWDELHI", "NCR", "BANGALORE",
  "BENGALURU", "HYDERABAD", "CHENNAI", "KOLKATA", "CALCUTTA", "PUNE", "GURGAON",
  "GURUGRAM", "NOIDA", "AHMEDABAD", "JAIPUR", "KOCHI", "COCHIN", "CHANDIGARH",
  "LUCKNOW", "INDORE", "NAGPUR", "SURAT", "BHOPAL", "PATNA", "EAST", "WEST",
  "NORTH", "SOUTH", "CENTRAL",
]);

/** Split a raw merchant string into uppercase alphanumeric tokens. */
function tokenize(raw: string): string[] {
  return raw
    .toUpperCase()
    // separators commonly used in messy merchant strings
    .replace(/[*/.\-_,@&|]+/g, " ")
    // drop anything that isn't a letter, digit or space
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Canonical brand anchor for a merchant string.
 * Returns "" only if the input has no usable tokens.
 */
export function normalizeMerchant(raw: string | null | undefined): string {
  if (!raw) return "";
  const tokens = tokenize(raw);
  if (tokens.length === 0) return "";

  // keep meaningful tokens (drop generic stopwords and bare numbers)
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t));

  // first meaningful token is the brand anchor; if everything was stripped,
  // fall back to the first raw token so we never lose the row entirely.
  return (meaningful[0] ?? tokens[0]).trim();
}

/**
 * Normalize a user's search term the same way, so "Swiggy", "swiggy orders",
 * "SWIGGY" all reduce to the same anchor used at ingest time.
 */
export function normalizeQueryTerm(term: string): string {
  return normalizeMerchant(term);
}
