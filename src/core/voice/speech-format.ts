import { toSpeakable } from "./speech-text";

/**
 * Speech formatter (ADR-030): prepares verified text for natural speech without changing what
 * it says. Markdown, links and citation marks go (toSpeakable); amounts, times and percentages
 * become words a person would say ("$23.500" → "veintitrés mil quinientos", "14:30" → "las dos
 * y media de la tarde"). Deterministic: the numbers are the same numbers, only spoken. Anything
 * it doesn't recognise is left exactly as written.
 */

type Lang = "es" | "en";

const ES_UNITS = [
  "cero",
  "uno",
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "seis",
  "siete",
  "ocho",
  "nueve",
  "diez",
  "once",
  "doce",
  "trece",
  "catorce",
  "quince",
  "dieciséis",
  "diecisiete",
  "dieciocho",
  "diecinueve",
  "veinte",
  "veintiuno",
  "veintidós",
  "veintitrés",
  "veinticuatro",
  "veinticinco",
  "veintiséis",
  "veintisiete",
  "veintiocho",
  "veintinueve",
];
const ES_TENS = [
  "",
  "",
  "",
  "treinta",
  "cuarenta",
  "cincuenta",
  "sesenta",
  "setenta",
  "ochenta",
  "noventa",
];
const ES_HUNDREDS = [
  "",
  "ciento",
  "doscientos",
  "trescientos",
  "cuatrocientos",
  "quinientos",
  "seiscientos",
  "setecientos",
  "ochocientos",
  "novecientos",
];
const EN_UNITS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const EN_TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

function esBelow1000(n: number): string {
  if (n === 100) return "cien";
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest =
    r === 0
      ? ""
      : r < 30
        ? ES_UNITS[r]!
        : `${ES_TENS[Math.floor(r / 10)]}${r % 10 ? ` y ${ES_UNITS[r % 10]}` : ""}`;
  return [h ? ES_HUNDREDS[h] : "", rest].filter(Boolean).join(" ");
}

function enBelow1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest =
    r === 0
      ? ""
      : r < 20
        ? EN_UNITS[r]!
        : `${EN_TENS[Math.floor(r / 10)]}${r % 10 ? `-${EN_UNITS[r % 10]}` : ""}`;
  return [h ? `${EN_UNITS[h]} hundred` : "", rest].filter(Boolean).join(" ");
}

/** A whole number (0 – 999.999.999) in words; null outside that range. */
export function numberWords(n: number, lang: Lang): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) return null;
  if (n === 0) return lang === "es" ? "cero" : "zero";
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  if (lang === "en")
    return [
      millions ? `${enBelow1000(millions)} million` : "",
      thousands ? `${enBelow1000(thousands)} thousand` : "",
      rest ? enBelow1000(rest) : "",
    ]
      .filter(Boolean)
      .join(" ");
  // "uno" → "un" before a noun-like scale ("un millón", "veintiún mil").
  const apocope = (w: string) => w.replace(/uno$/, "ún").replace(/^ún$/, "un");
  return [
    millions ? (millions === 1 ? "un millón" : `${apocope(esBelow1000(millions))} millones`) : "",
    thousands ? (thousands === 1 ? "mil" : `${apocope(esBelow1000(thousands))} mil`) : "",
    rest ? esBelow1000(rest) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** "23.500" / "23,500" (es / en grouping) → 23500; null when it isn't a plain grouped integer. */
function parseGrouped(raw: string, lang: Lang): number | null {
  const group = lang === "es" ? "." : ",";
  if (new RegExp(`^\\d{1,3}(\\${group}\\d{3})+$`).test(raw))
    return Number(raw.split(group).join(""));
  if (/^\d+$/.test(raw)) return Number(raw);
  return null;
}

const CURRENCY: Record<string, { es: string; en: string }> = {
  US$: { es: "dólares", en: "dollars" },
  USD: { es: "dólares", en: "dollars" },
  "€": { es: "euros", en: "euros" },
  EUR: { es: "euros", en: "euros" },
  ARS: { es: "pesos", en: "pesos" },
};

function clock(h: number, m: number, lang: Lang): string | null {
  if (h > 23 || m > 59) return null;
  if (lang === "en") return null; // English TTS reads "2:30 PM" naturally; left as written.
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const hour = h12 === 1 ? "la una" : `las ${numberWords(h12, "es")}`;
  const minutes =
    m === 0 ? "" : m === 15 ? " y cuarto" : m === 30 ? " y media" : ` y ${numberWords(m, "es")}`;
  const part =
    h < 6
      ? " de la madrugada"
      : h < 12
        ? " de la mañana"
        : h < 20
          ? " de la tarde"
          : " de la noche";
  return `${hour}${minutes}${part}`;
}

export function formatForSpeech(text: string, lang: Lang): string {
  let t = toSpeakable(text);
  // Times: "a las 14:30" / "14:30 hs" → "a las dos y media de la tarde".
  t = t.replace(/\b(?:(?:a )?las |la )?(\d{1,2}):(\d{2})(?:\s?(?:hs|h|horas))?\b/gi, (m, h, mm) => {
    const said = clock(Number(h), Number(mm), lang);
    if (!said) return m;
    return /^a las|^a la/i.test(m) ? `a ${said}` : said;
  });
  // Amounts with a currency: "US$ 1.200", "€300", "$23.500".
  t = t.replace(
    /(US\$|USD|EUR|ARS|€|\$)\s?(\d{1,3}(?:[.,]\d{3})+|\d+)(?![.,]\d)/g,
    (m, cur: string, num: string) => {
      const n = parseGrouped(num, lang);
      const words = n !== null ? numberWords(n, lang) : null;
      if (!words) return m;
      const unit = CURRENCY[cur]?.[lang];
      // A bare "$" is local currency: the number alone reads naturally ("veintitrés mil").
      return unit ? `${words} ${unit}` : words;
    },
  );
  // Percentages: "12%" → "12 por ciento" (the TTS reads the integer itself).
  t = t.replace(/(\d+(?:[.,]\d+)?)\s?%/g, (_m, num: string) =>
    lang === "es" ? `${num} por ciento` : `${num} percent`,
  );
  // Grouped integers on their own: "23.500 visitantes" → words (an exact count stays exact).
  t = t.replace(/(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+)(?![.,]?\d)/g, (m, num: string) => {
    const n = parseGrouped(num, lang);
    return (n !== null ? numberWords(n, lang) : null) ?? m;
  });
  // "&" and "/" read badly; arrows and bullets are visual only.
  t = t
    .replace(/\s&\s/g, lang === "es" ? " y " : " and ")
    .replace(/[→•·]/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}
