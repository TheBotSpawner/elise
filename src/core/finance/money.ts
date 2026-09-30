/**
 * Money without floating point (docs/architecture/10 §24-25). Amounts travel as decimal strings
 * ("48000", "25.5") and are summed as scaled integers (4 decimal places, matching the database's
 * numeric(20, 4)). Different currencies are never added together: totals are always per currency.
 */

export const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);

export type Money = { amount: string; currency: string };

// Up to 20 decimals so a spreadsheet's 0.30000000000000004 still parses (then rounds to 4).
const DECIMAL = /^-?\d{1,16}(\.\d{1,20})?$/;

export function isDecimal(value: string): boolean {
  return DECIMAL.test(value);
}

/**
 * "25.5" → 255000n. Extra decimals are rounded half away from zero, so a spreadsheet's
 * 0.30000000000000004 becomes 0.3000. Throws on anything that is not a plain decimal.
 */
export function toUnits(value: string): bigint {
  if (!isDecimal(value)) throw new Error(`Not a decimal amount: ${value}`);
  const negative = value.startsWith("-");
  const [int, frac = ""] = (negative ? value.slice(1) : value).split(".");
  const kept = frac.slice(0, SCALE).padEnd(SCALE, "0");
  let units = BigInt(int!) * FACTOR + BigInt(kept);
  if (frac.length > SCALE && Number(frac[SCALE]) >= 5) units += 1n;
  return negative ? -units : units;
}

/** 255000n → "25.5" (trailing zeros trimmed; at least the integer part). */
export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const int = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** Canonical form of a decimal string (what the database would store). */
export function normalizeAmount(value: string): string {
  return fromUnits(toUnits(value));
}

export function addAmounts(...values: string[]): string {
  return fromUnits(values.reduce((sum, v) => sum + toUnits(v), 0n));
}

export function subtractAmounts(a: string, b: string): string {
  return fromUnits(toUnits(a) - toUnits(b));
}

export function compareAmounts(a: string, b: string): number {
  const d = toUnits(a) - toUnits(b);
  return d === 0n ? 0 : d > 0n ? 1 : -1;
}

/** Percentage change a → b, rounded to one decimal; null when a is zero. */
export function percentChange(from: string, to: string): number | null {
  const a = toUnits(from);
  if (a === 0n) return null;
  // Integer arithmetic in tenths of a percent, then one division for display.
  const tenths = ((toUnits(to) - a) * 1000n) / (a < 0n ? -a : a);
  return Number(tenths) / 10;
}

/** Average of amounts, rounded to the stored scale. */
export function averageAmount(values: string[]): string {
  if (!values.length) return "0";
  const sum = values.reduce((s, v) => s + toUnits(v), 0n);
  return fromUnits(sum / BigInt(values.length));
}

/** ISO 4217-shaped code. The list of real currencies is open (users hold what they hold). */
export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

/** Common ways people write currencies → ISO code. Ambiguous "$" is resolved by the caller. */
const CURRENCY_WORDS: Record<string, string> = {
  usd: "USD",
  us$: "USD",
  u$s: "USD",
  u$d: "USD",
  dolar: "USD",
  dolares: "USD",
  dollar: "USD",
  dollars: "USD",
  ars: "ARS",
  peso: "ARS",
  pesos: "ARS",
  ar$: "ARS",
  eur: "EUR",
  euro: "EUR",
  euros: "EUR",
  "€": "EUR",
  nzd: "NZD",
  nz$: "NZD",
  gbp: "GBP",
  "£": "GBP",
  brl: "BRL",
  r$: "BRL",
  reales: "BRL",
  clp: "CLP",
  uyu: "UYU",
  mxn: "MXN",
  aud: "AUD",
  cad: "CAD",
  jpy: "JPY",
  "¥": "JPY",
};

/** "dólares" → USD, "usd" → USD, "ars" → ARS. "$" alone is ambiguous → null. */
export function normalizeCurrency(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (isCurrencyCode(raw)) return raw;
  const key = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, "");
  if (CURRENCY_WORDS[key]) return CURRENCY_WORDS[key]!;
  return /^[a-z]{3}$/.test(key) ? key.toUpperCase() : null;
}

export type NumberFormat = "dot_decimal" | "comma_decimal";

/**
 * Parses an amount as people type it in spreadsheets: "$ 1.234,56", "1,234.56", "-25", "48000",
 * "(1.200,00)". The decimal separator comes from `format`; without it, only unambiguous values
 * parse ("1.234,56" is clearly comma-decimal, "1,234" is not clear and returns null).
 * Returns the absolute value as a decimal string plus the sign it carried.
 */
export function parseAmount(
  input: string,
  format: NumberFormat | null,
): { amount: string; negative: boolean } | null {
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[A-Za-z$€£¥\s  ]/g, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!/^[\d.,']+$/.test(s) || !/\d/.test(s)) return null;
  s = s.replace(/'/g, "");
  const fmt = format ?? detectNumberFormat([s]);
  let normalized: string;
  // Grouping is always in threes, so "25.5" can't be comma-locale grouping and "25,5" can't be
  // dot-locale grouping: those read with the other separator (numeric cells of spreadsheets
  // arrive as "25.5" whatever the file's locale).
  if (fmt === "comma_decimal") {
    if (/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(s))
      normalized = s.replace(/\./g, "").replace(",", ".");
    else if (/^\d+\.\d+$/.test(s)) normalized = s;
    else return null;
  } else if (fmt === "dot_decimal") {
    if (/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(s)) normalized = s.replace(/,/g, "");
    else if (/^\d+,\d+$/.test(s)) normalized = s.replace(",", ".");
    else return null;
  } else {
    // No separators at all: an integer either way.
    if (!/^\d+$/.test(s)) return null;
    normalized = s;
  }
  if (!isDecimal(normalized)) return null;
  const amount = normalizeAmount(normalized);
  return { amount, negative };
}

/**
 * Which decimal separator a column uses, from its values. "1.234,56" or "12,5" → comma;
 * "1,234.56" or "12.50" → dot. Values like "1.234" or "1,234" alone are ambiguous (thousands
 * or decimals?) → null, and the user is asked.
 */
export function detectNumberFormat(values: readonly string[]): NumberFormat | null {
  let comma = 0;
  let dot = 0;
  for (const raw of values) {
    const s = raw.replace(/[^\d.,]/g, "");
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastComma > lastDot) comma++;
      else dot++;
      continue;
    }
    const sep = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
    if (!sep) continue;
    const parts = s.split(sep);
    const tail = parts.at(-1)!;
    // One separator followed by exactly 3 digits could be thousands: ambiguous on its own.
    if (parts.length === 2 && tail.length === 3) continue;
    if (parts.length > 2) {
      // Repeated separator = thousands grouping ("1.234.567" → comma-decimal locale).
      if (sep === ".") comma++;
      else dot++;
      continue;
    }
    if (sep === ",") comma++;
    else dot++;
  }
  if (comma && !dot) return "comma_decimal";
  if (dot && !comma) return "dot_decimal";
  return null;
}

/** Display with grouping for the user's locale, keeping every stored decimal that matters. */
export function formatMoney(amount: string, currency: string, locale: string): string {
  const units = toUnits(amount);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const cents = abs % (FACTOR / 100n) === 0n;
  const int = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, "0");
  const decimals = cents ? frac.slice(0, 2) : frac.replace(/0+$/, "");
  const intText = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(int);
  const decimalSep = new Intl.NumberFormat(locale).format(1.5).charAt(1);
  const showDecimals = decimals !== "00";
  return `${negative ? "−" : ""}${currency} ${intText}${showDecimals ? `${decimalSep}${decimals}` : ""}`;
}
