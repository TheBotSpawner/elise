import type { ScheduleDefinition } from "@/core/schedules/schedule";
import { addDays, todayIn } from "@/core/time";
import type { Dictionary } from "@/lib/i18n";

/** "Weekdays · 07:30", "Mon, Wed · 09:00", "Once · Oct 3 · 18:00". */
export function describeWhen(def: ScheduleDefinition, t: Dictionary, locale: string): string {
  if (def.kind === "once") {
    const [date, time] = def.at.split("T");
    const day = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00Z`));
    return `${t.schedules.once} · ${day} · ${time}`;
  }
  const key = def.days.join(",");
  const days =
    key === "0,1,2,3,4,5,6"
      ? t.schedules.everyDay
      : key === "1,2,3,4,5"
        ? t.schedules.weekdays
        : key === "0,6"
          ? t.schedules.weekends
          : def.days.map((d) => t.schedules.days[d]).join(", ");
  return `${days} · ${def.time}`;
}

/** "Today 07:30", "Tomorrow 07:30", "Fri 3 · 07:30" in the schedule's timezone. */
export function describeInstant(iso: string, timezone: string, t: Dictionary, locale: string) {
  const d = new Date(iso);
  const date = todayIn(timezone, d);
  const today = todayIn(timezone);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  }).format(d);
  if (date === today) return `${t.schedules.today} ${time}`;
  if (date === addDays(today, 1)) return `${t.schedules.tomorrow} ${time}`;
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: timezone,
  }).format(d);
  return `${day} · ${time}`;
}
