// Strips noise from merchant strings to get a brand anchor.
// e.g. "SWIGGY*ORDER", "Swiggy Instamart", "SWIGGY BANGALORE" all -> "SWIGGY"
// No hardcoded brand names - just generic noise removal so it works on any dataset.

const STOPWORDS = new Set<string>([
  "PVT", "PVTLTD", "LTD", "LIMITED", "PRIVATE", "INC", "LLP", "LLC", "CO", "CORP",
  "COMPANY", "GROUP", "HOLDINGS",
  "SYSTEMS", "TECHNOLOGIES", "TECHNOLOGY", "TECH", "SOLUTIONS", "SERVICES", "SERVICE",
  "ENTERPRISES", "ENTERPRISE", "INDUSTRIES", "RETAIL", "ONLINE", "DIGITAL", "GLOBAL",
  "INTERNATIONAL", "VENTURES", "LABS",
  "ORDER", "ORDERS", "TRIP", "TRIPS", "BOOKING", "BOOKINGS", "PAYMENT", "PAYMENTS",
  "PAY", "TXN", "TRANSACTION", "PURCHASE", "BILL", "RECHARGE", "SUBSCRIPTION",
  "COM", "IN", "WWW", "NET", "ORG", "APP", "IO",
  "INDIA", "BHARAT", "MUMBAI", "BOMBAY", "DELHI", "NEWDELHI", "NCR", "BANGALORE",
  "BENGALURU", "HYDERABAD", "CHENNAI", "KOLKATA", "CALCUTTA", "PUNE", "GURGAON",
  "GURUGRAM", "NOIDA", "AHMEDABAD", "JAIPUR", "KOCHI", "COCHIN", "CHANDIGARH",
  "LUCKNOW", "INDORE", "NAGPUR", "SURAT", "BHOPAL", "PATNA", "EAST", "WEST",
  "NORTH", "SOUTH", "CENTRAL",
]);

function tokenize(raw: string): string[] {
  return raw
    .toUpperCase()
    .replace(/[*/.\-_,@&|]+/g, " ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function normalizeMerchant(raw: string | null | undefined): string {
  if (!raw) return "";
  const tokens = tokenize(raw);
  if (tokens.length === 0) return "";
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t));
  return (meaningful[0] ?? tokens[0]).trim();
}

export function normalizeQueryTerm(term: string): string {
  return normalizeMerchant(term);
}
