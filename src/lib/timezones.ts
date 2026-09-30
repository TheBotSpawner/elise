/**
 * Friendly timezone labels for pickers. The stored value is always the canonical IANA id
 * ("America/Argentina/Buenos_Aires"); the label is only what people read and search.
 */

const words = (s: string) => s.replace(/_/g, " ");

/** "America/Argentina/Buenos_Aires" → "Buenos Aires, Argentina"; "Europe/London" → "London, Europe". */
export function timezoneLabel(zone: string): string {
  const parts = zone.split("/");
  if (parts.length === 1) return words(zone);
  const city = words(parts.at(-1)!);
  const region = words(parts.length > 2 ? parts[parts.length - 2]! : parts[0]!);
  return `${city}, ${region}`;
}

function offset(zone: string, now: Date): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName");
    return part?.value ?? "";
  } catch {
    return "";
  }
}

export function timezoneOptions(zones: readonly string[], now = new Date()) {
  return zones.map((zone) => ({
    value: zone,
    label: timezoneLabel(zone),
    detail: `${zone} · ${offset(zone, now)}`,
    keywords: words(zone.replace(/\//g, " ")),
  }));
}
