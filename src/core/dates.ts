/**
 * How short dates read (ADR-078): day first by default ("05-10" is October 5th), month first
 * when the user chooses it in Settings › General. Data keeps ISO dates; only display changes.
 */
export const DATE_ORDERS = ["dmy", "mdy"] as const;
export type DateOrder = (typeof DATE_ORDERS)[number];
export const DEFAULT_DATE_ORDER: DateOrder = "dmy";

/** Where it lives: `user_preferences`, per person and workspace. */
export const DATE_ORDER_PREFERENCE_KEY = "display.date_order";

export const resolveDateOrder = (v: unknown): DateOrder =>
  (DATE_ORDERS as readonly unknown[]).includes(v) ? (v as DateOrder) : DEFAULT_DATE_ORDER;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-10-05" → "05-10" (dmy) or "10-05" (mdy); anything that isn't a plain day, unchanged. */
export function shortDay(value: string, order: DateOrder = DEFAULT_DATE_ORDER): string {
  const m = ISO_DAY.exec(value);
  if (!m) return value;
  return order === "dmy" ? `${m[3]}-${m[2]}` : `${m[2]}-${m[3]}`;
}

/**
 * A chart or table spec with its day labels shortened: the x axis, table cells and row labels.
 * Temporal specs (timeline, calendar) keep their ISO dates: those are data, not labels.
 */
export function withShortDays<T extends { type: string }>(
  spec: T,
  order: DateOrder = DEFAULT_DATE_ORDER,
): T {
  const s = spec as T & { x?: unknown; rows?: unknown };
  const day = (v: unknown) => (typeof v === "string" ? shortDay(v, order) : v);
  const out: Record<string, unknown> = { ...s };
  if (Array.isArray(s.x)) out.x = s.x.map(day);
  if (Array.isArray(s.rows))
    out.rows = s.rows.map((r: unknown) =>
      Array.isArray(r)
        ? r.map(day)
        : r && typeof r === "object" && "label" in r
          ? { ...r, label: day((r as { label: unknown }).label) }
          : r,
    );
  return out as T;
}
