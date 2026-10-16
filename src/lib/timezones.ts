import { canonicalTimezone } from "@/core/time";

/**
 * Friendly timezone labels for pickers (ADR-069). The stored value is always the canonical IANA
 * id ("America/Argentina/Buenos_Aires"); people read "Buenos Aires, Argentina · UTC-3" and can
 * search by city, country, offset or the raw id.
 */

const words = (s: string) => s.replace(/_/g, " ");

/** Countries for zones whose id doesn't name one (most do: "America/Argentina/…"). */
const COUNTRY: Record<string, string> = {
  "America/Sao_Paulo": "BR",
  "America/Bahia": "BR",
  "America/Fortaleza": "BR",
  "America/Recife": "BR",
  "America/Belem": "BR",
  "America/Manaus": "BR",
  "America/Cuiaba": "BR",
  "America/Campo_Grande": "BR",
  "America/Porto_Velho": "BR",
  "America/Rio_Branco": "BR",
  "America/Noronha": "BR",
  "America/Montevideo": "UY",
  "America/Asuncion": "PY",
  "America/Santiago": "CL",
  "America/Punta_Arenas": "CL",
  "America/La_Paz": "BO",
  "America/Lima": "PE",
  "America/Bogota": "CO",
  "America/Caracas": "VE",
  "America/Guayaquil": "EC",
  "America/Panama": "PA",
  "America/Costa_Rica": "CR",
  "America/Mexico_City": "MX",
  "America/Cancun": "MX",
  "America/Monterrey": "MX",
  "America/Tijuana": "MX",
  "America/Havana": "CU",
  "America/Santo_Domingo": "DO",
  "America/Puerto_Rico": "PR",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Phoenix": "US",
  "America/Los_Angeles": "US",
  "America/Anchorage": "US",
  "Pacific/Honolulu": "US",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Montreal": "CA",
  "Europe/London": "GB",
  "Europe/Dublin": "IE",
  "Europe/Lisbon": "PT",
  "Europe/Madrid": "ES",
  "Atlantic/Canary": "ES",
  "Europe/Paris": "FR",
  "Europe/Berlin": "DE",
  "Europe/Rome": "IT",
  "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE",
  "Europe/Zurich": "CH",
  "Europe/Vienna": "AT",
  "Europe/Stockholm": "SE",
  "Europe/Oslo": "NO",
  "Europe/Copenhagen": "DK",
  "Europe/Helsinki": "FI",
  "Europe/Warsaw": "PL",
  "Europe/Prague": "CZ",
  "Europe/Athens": "GR",
  "Europe/Istanbul": "TR",
  "Europe/Kyiv": "UA",
  "Europe/Moscow": "RU",
  "Asia/Jerusalem": "IL",
  "Asia/Dubai": "AE",
  "Asia/Kolkata": "IN",
  "Asia/Shanghai": "CN",
  "Asia/Hong_Kong": "HK",
  "Asia/Tokyo": "JP",
  "Asia/Seoul": "KR",
  "Asia/Singapore": "SG",
  "Asia/Bangkok": "TH",
  "Asia/Jakarta": "ID",
  "Asia/Manila": "PH",
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "Australia/Perth": "AU",
  "Pacific/Auckland": "NZ",
  "Africa/Johannesburg": "ZA",
  "Africa/Cairo": "EG",
  "Africa/Lagos": "NG",
};

export function timezoneCountry(zone: string): string | null {
  if (zone.startsWith("America/Argentina/")) return "AR";
  return COUNTRY[zone] ?? null;
}

const regionNames = new Map<string, Intl.DisplayNames>();
function countryName(code: string, locale: string): string {
  let names = regionNames.get(locale);
  if (!names) {
    names = new Intl.DisplayNames([locale], { type: "region" });
    regionNames.set(locale, names);
  }
  return names.of(code) ?? code;
}

/**
 * "America/Argentina/Buenos_Aires" → "Buenos Aires, Argentina"; "America/Sao_Paulo" →
 * "Sao Paulo, Brasil" (es); unknown countries keep the id's region ("London, Europe").
 */
export function timezoneLabel(zone: string, locale = "es"): string {
  const z = canonicalTimezone(zone);
  const parts = z.split("/");
  if (parts.length === 1) return words(z);
  const city = words(parts.at(-1)!);
  const country = timezoneCountry(z);
  const region = country
    ? countryName(country, locale)
    : words(parts.length > 2 ? parts[parts.length - 2]! : parts[0]!);
  return `${city}, ${region}`;
}

/** "UTC-3", "UTC+5:30", "UTC" — never "GMT". */
function offset(zone: string, now: Date): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName");
    return (part?.value ?? "").replace(/^GMT/, "UTC");
  } catch {
    return "";
  }
}

const ARGENTINA = "America/Argentina/Buenos_Aires";

/**
 * Picker options: canonical ids only (aliases folded in), the current one kept even if the
 * runtime doesn't list it, sorted by label. With `preferArgentina`, Buenos Aires comes first —
 * easier to find, never chosen for the person.
 */
export function timezoneOptions(
  zones: readonly string[],
  now = new Date(),
  opts: { locale?: string; current?: string; preferArgentina?: boolean } = {},
) {
  const locale = opts.locale ?? "es";
  const ids = new Set(zones.map(canonicalTimezone));
  if (opts.current) ids.add(canonicalTimezone(opts.current));
  if (opts.preferArgentina) ids.add(ARGENTINA);
  const options = [...ids].map((zone) => {
    const label = timezoneLabel(zone, locale);
    const country = timezoneCountry(zone);
    const utc = offset(zone, now);
    return {
      value: zone,
      label,
      detail: `${utc ? `${utc} · ` : ""}${zone}`,
      keywords: [
        words(zone.replace(/\//g, " ")),
        utc,
        country ? `${countryName(country, "es")} ${countryName(country, "en")}` : "",
      ].join(" "),
    };
  });
  options.sort((a, b) => a.label.localeCompare(b.label, locale));
  if (!opts.preferArgentina) return options;
  const ba = options.findIndex((o) => o.value === ARGENTINA);
  return ba > 0 ? [options[ba]!, ...options.slice(0, ba), ...options.slice(ba + 1)] : options;
}

/** Argentina first when the person likely lives there: an Argentine zone, or Spanish (es-AR). */
export function prefersArgentina(locale: string, current: string | null): boolean {
  return (
    Boolean(current && timezoneCountry(canonicalTimezone(current)) === "AR") || locale === "es"
  );
}
