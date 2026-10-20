import { app, Notification } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { log } from "./log";

/**
 * The next alarms this installation rings (ADR-100), kept by the app itself: they fire with the
 * cloud unreachable, minimized or in the tray, and after a restart (kept on disk). The page sends
 * the list (server truth); this only counts down. A fire too old (asleep, app closed) is skipped:
 * the server marks it missed — no catch-up storm.
 */

export const alarmItemsSchema = z
  .array(
    z.object({
      alarmId: z.string().uuid(),
      fireAt: z.string().datetime(),
      label: z.string().max(80).nullable(),
    }),
  )
  .max(50);
export type AlarmItem = z.infer<typeof alarmItemsSchema>[number];

const LATE_MS = 10 * 60_000;
/** setTimeout caps at ~24.8 days; the list only holds the next 48 h anyway. */
const MAX_DELAY = 2 ** 31 - 1;

const file = () => join(app.getPath("userData"), "alarms.json");
const timers = new Map<string, NodeJS.Timeout>();
const fired = new Set<string>();
let onFire: (item: AlarmItem) => void = () => undefined;

export function scheduleAlarms(items: AlarmItem[]) {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  const now = Date.now();
  for (const item of items) {
    const key = `${item.alarmId}|${item.fireAt}`;
    const delay = Date.parse(item.fireAt) - now;
    if (fired.has(key) || delay < -LATE_MS || delay > MAX_DELAY) continue;
    timers.set(
      key,
      setTimeout(
        () => {
          timers.delete(key);
          fired.add(key);
          log("desktop_alarm_fired", {});
          onFire(item);
        },
        Math.max(0, delay),
      ),
    );
  }
  try {
    writeFileSync(file(), JSON.stringify(items), { mode: 0o600 });
  } catch {
    // Not kept: the page sends the list again when it loads.
  }
}

/** Starts from what was kept on disk; `fire` makes sure a window rings it. */
export function startAlarms(fire: (item: AlarmItem) => void) {
  onFire = (item) => {
    if (Notification.isSupported())
      new Notification({ title: "ELISE", body: item.label ?? "⏰", silent: true }).show();
    fire(item);
  };
  try {
    scheduleAlarms(alarmItemsSchema.parse(JSON.parse(readFileSync(file(), "utf8"))));
  } catch {
    // Nothing kept yet.
  }
}
