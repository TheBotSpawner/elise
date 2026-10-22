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
  // Math symbols the voice can't say: "√π ≈ 1,77245" → "raíz cuadrada de pi, aproximadamente…".
  const es = lang === "es";
  t = t
    .replace(/π/g, "pi")
    .replace(/√\s?/g, es ? "raíz cuadrada de " : "square root of ")
    .replace(/\s?≈\s?/g, es ? ", aproximadamente " : ", approximately ");
  // ADR-104: in Spanish, an "OK" interjection opening a sentence is said the Rioplatense way.
  // Only there: "el OK del banco" or a product name is left alone. The screen keeps the text.
  if (lang === "es") t = t.replace(/(^|[.!?¡¿]\s+)(?:ok|okay|okey)\b[,.!]?\s*/gi, "$1Dale, ");
  t = t.replace(/Dale, ([.!?])/g, "Dale$1").replace(/Dale, $/, "Dale.");
  if (lang === "es") {
    // Durations are not times of day: "1:55:30" is a race time, and "5:30 el kilómetro", "5:30
    // a 6 min/km" or "ritmo de 5:30" are paces — never "las cinco y media de la madrugada".
    // "uno" agrees with what it counts: "un minuto", "veintiún segundos", "una hora".
    const count = (n: number, one: string, many: string, feminine = false) =>
      `${(numberWords(n, "es") ?? String(n)).replace(/uno$/, feminine ? "una" : n === 1 ? "un" : "ún")} ${n === 1 ? one : many}`;
    const mins = (m: number, s: number) =>
      `${count(m, "minuto", "minutos")}${s ? ` y ${count(s, "segundo", "segundos")}` : ""}`;
    t = t.replace(
      /\b(\d{1,2}):([0-5]\d):([0-5]\d)\b/g,
      (_, h, m, s) => `${count(Number(h), "hora", "horas", true)}, ${mins(Number(m), Number(s))}`,
    );
    t = t.replace(
      /\b(\d{1,2}):([0-5]\d)(?=(?:\s*(?:a|y|-|–)\s*\d{1,2}(?::[0-5]\d)?)?\s*(?:min(?:utos)?\b|\/\s*km\b|(?:el|por|cada) (?:km|kil[oó]metro)))/gi,
      (_, m, s) => mins(Number(m), Number(s)),
    );
    t = t.replace(
      /\b(ritmo|pace|promedio|parcial|tiempo) (de |en )?(\d{1,2}):([0-5]\d)\b/gi,
      (_, word, prep, m, s) => `${word} ${prep ?? ""}${mins(Number(m), Number(s))}`,
    );
  }
  // Times: "a las 14:30" / "14:30 hs" → "a las dos y media de la tarde".
  t = t.replace(/\b(?:(?:a )?las |la )?(\d{1,2}):(\d{2})(?:\s?(?:hs|h|horas))?\b/gi, (m, h, mm) => {
    const said = clock(Number(h), Number(mm), lang);
    if (!said) return m;
    return /^a las|^a la/i.test(m) ? `a ${said}` : said;
  });
  // ADR-104: the decimal separator of the language ("1.573.655,09" in Spanish). Raw digits with
  // dots and commas reached the voice and it stumbled (and once beeped) reading a balance.
  const dec = lang === "es" ? "," : "\\.";
  const cents = (frac: string | undefined) => {
    const c = frac ? Number(frac.padEnd(2, "0")) : 0;
    return c ? numberWords(c, lang) : null;
  };
  const withCents = (words: string, unit: string | null, frac: string | undefined) => {
    const c = cents(frac);
    const and = lang === "es" ? "con" : "and";
    const centWord = lang === "es" ? (c === "uno" ? "centavo" : "centavos") : "cents";
    const whole = unit ? `${words} ${unit}` : words;
    return c ? `${whole} ${and} ${c === "uno" ? "un" : c} ${centWord}` : whole;
  };
  // Amounts with a currency: "US$ 1.200", "€300", "$23.500", "$ 1.573.655,09".
  t = t.replace(
    new RegExp(
      `(US\\$|USD|EUR|ARS|€|\\$)\\s?(\\d{1,3}(?:[.,]\\d{3})+|\\d+)(?:${dec}(\\d{1,2}))?(?![.,]?\\d)`,
      "g",
    ),
    (m, cur: string, num: string, frac: string | undefined) => {
      const n = parseGrouped(num, lang);
      const words = n !== null ? numberWords(n, lang) : null;
      if (!words) return m;
      // A bare "$" is local currency: the number alone reads naturally ("veintitrés mil").
      return withCents(words, CURRENCY[cur]?.[lang] ?? null, frac);
    },
  );
  // An amount written before its currency word: "1.573.655,09 pesos", "25,50 dólares".
  t = t.replace(
    new RegExp(
      `(?<![\\d.,])(\\d{1,3}(?:[.,]\\d{3})+|\\d+)${dec}(\\d{1,2})(?!\\d)\\s+(pesos|d[oó]lares|euros|dollars)\\b`,
      "gi",
    ),
    (m, num: string, frac: string, unit: string) => {
      const n = parseGrouped(num, lang);
      const words = n !== null ? numberWords(n, lang) : null;
      return words ? withCents(words, unit, frac) : m;
    },
  );
  // Percentages: "12%" → "12 por ciento" (the TTS reads the integer itself).
  t = t.replace(/(\d+(?:[.,]\d+)?)\s?%/g, (_m, num: string) =>
    lang === "es" ? `${num} por ciento` : `${num} percent`,
  );
  // Any other decimal: "97.942,65 puntos" → "… coma sesenta y cinco". Digits after a zero, and
  // any longer tail, are said one by one: "0,05" → "cero coma cero cinco", "√π ≈ 1,77245" →
  // "uno coma siete siete dos cuatro cinco" (left raw, the voice stumbled on it).
  t = t.replace(
    new RegExp(`(?<![\\d.,])(\\d{1,3}(?:[.,]\\d{3})+|\\d+)${dec}(\\d+)(?![.,]?\\d)`, "g"),
    (m, num: string, frac: string) => {
      const n = parseGrouped(num, lang);
      const whole = n !== null ? numberWords(n, lang) : null;
      if (!whole) return m;
      const point = lang === "es" ? "coma" : "point";
      const after =
        frac.startsWith("0") || frac.length > 2
          ? [...frac].map((d) => numberWords(Number(d), lang)).join(" ")
          : numberWords(Number(frac), lang);
      return `${whole} ${point} ${after}`;
    },
  );
  // Grouped integers on their own: "23.500 visitantes" → words (an exact count stays exact).
  t = t.replace(/(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+)(?![.,]?\d)/g, (m, num: string) => {
    const n = parseGrouped(num, lang);
    return (n !== null ? numberWords(n, lang) : null) ?? m;
  });
  // ADR-104: a long code with no separators (a ticket 2043535, an ID, a phone) is said digit by
  // digit, the way it's read out loud — never as "two million forty-three thousand…".
  t = t.replace(/(?<![\d.,:/-])(\d{6,})(?![\d]|[.,]\d)/g, (_m, num: string) =>
    [...num].map((d) => numberWords(Number(d), lang)).join(" "),
  );
  // ADR-104: plain integers of 3–5 digits ("Pedro Lozano 4418", "1500 metros") in words too:
  // the voice stumbled on a street number. A year stays as written ("en 2026", "de 1998").
  const yearBefore =
    lang === "es"
      ? /(?:^|\s)(?:de|del|en|año|el|desde|hasta|para|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s$/i
      : /(?:^|\s)(?:in|of|since|until|by|year|january|february|march|april|may|june|july|august|september|october|november|december)\s$/i;
  // (Decimals were said above: a comma or dot left after a number is punctuation.)
  t = t.replace(/(?<![\d.,:/-])(\d{3,5})(?![\d:/%]|[.,]\d|\s?°)/g, (m, num: string, at: number) => {
    const n = Number(num);
    if (n >= 1900 && n <= 2099 && yearBefore.test(t.slice(Math.max(0, at - 12), at))) return m;
    return numberWords(n, lang) ?? m;
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
