import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import {
  armed,
  BUNDLED_SOUNDS,
  type Alarm,
  type AlarmPatch,
  type AlarmStore,
  type DestinationStatus,
  type NewAlarm,
} from "@/core/timers/alarms";
import { DEFAULT_TIME_PREFERENCES, type TimePreferences } from "@/core/timers/model";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

// Monday 19 Oct 2026, 15:00 in Buenos Aires (UTC-3).
const NOW = new Date("2026-10-19T18:00:00Z");

class MemoryAlarms implements AlarmStore {
  alarms: Alarm[] = [];
  prefs: TimePreferences = { ...DEFAULT_TIME_PREFERENCES };
  constructor(public known: DestinationStatus[]) {}
  async preferences() {
    return this.prefs;
  }
  async listAlarms() {
    return this.alarms;
  }
  async createAlarm(n: NewAlarm) {
    const a: Alarm = {
      id: `00000000-0000-4000-8000-00000000000${this.alarms.length + 1}`,
      label: n.label,
      time: n.time,
      date: n.date,
      weekdays: n.weekdays,
      timezone: n.timezone,
      enabled: true,
      sound: n.sound,
      snoozeMinutes: n.snoozeMinutes,
      destinations: n.destinations,
      snoozedUntil: null,
      version: 1,
      ...armed({ ...n, enabled: true }, NOW),
    };
    this.alarms.push(a);
    return a;
  }
  async changeAlarm(a: Alarm, patch: AlarmPatch) {
    const next = { ...a, ...patch, version: a.version + 1 } as Alarm;
    Object.assign(next, armed(next, NOW));
    this.alarms = this.alarms.map((x) => (x.id === a.id ? next : x));
    return next;
  }
  async deleteAlarm(a: Alarm) {
    this.alarms = this.alarms.filter((x) => x.id !== a.id);
  }
  async liveOccurrences() {
    return [];
  }
  async occurrenceAction(): Promise<never> {
    throw new Error("none");
  }
  async destinations() {
    return this.known;
  }
  async sounds() {
    return BUNDLED_SOUNDS.map((k) => ({ key: k, name: k, kind: "bundled" as const }));
  }
  async setDefaultSound(key: string) {
    this.prefs = { ...this.prefs, alarmSound: key };
  }
  async setDefaultDestinations(d: TimePreferences["alarmDestinations"]) {
    this.prefs = { ...this.prefs, alarmDestinations: d };
  }
}

const DESKTOP: DestinationStatus = {
  kind: "desktop",
  id: "11111111-1111-4111-8111-111111111111",
  name: "PC Leo",
  online: true,
  lastSeenAt: NOW.toISOString(),
};
const BROWSER: DestinationStatus = {
  kind: "browser",
  id: "22222222-2222-4222-8222-222222222222",
  name: "Chrome · Windows",
  online: false,
  lastSeenAt: null,
};

function setup(known: DestinationStatus[]) {
  const store = new MemoryAlarms(known);
  const { ports } = makePorts([], { internal: store });
  const call = (name: string, args: unknown) =>
    executeToolCall(ports, makeCtx({ now: NOW }), { name, args });
  return { store, call };
}
const out = (r: unknown) => (r as { output: Record<string, unknown> }).output;

describe("alarm tools (ADR-100)", () => {
  it("sets tomorrow 07:00 in the user's timezone, on the device asked", async () => {
    const { store, call } = setup([DESKTOP, BROWSER]);
    const r = await call("time.setAlarm", {
      time: "07:00",
      day: "tomorrow",
      label: "Facultad",
      destinations: ["PC"],
    });
    const a = store.alarms[0]!;
    expect(a.date).toBe("2026-10-20");
    expect(a.nextFireAt).toBe("2026-10-20T10:00:00.000Z");
    expect(a.destinations).toEqual([{ kind: "desktop", id: DESKTOP.id }]);
    expect((out(r).created as { ringsOn: string[] }).ringsOn).toEqual(["PC Leo"]);
  });

  it("an hour already past today rings tomorrow", async () => {
    const { store, call } = setup([DESKTOP]);
    await call("time.setAlarm", { time: "09:00", destinations: ["desktop"] });
    expect(store.alarms[0]!.date).toBe("2026-10-20");
  });

  it("repeats Monday and Wednesday", async () => {
    const { store, call } = setup([DESKTOP]);
    await call("time.setAlarm", {
      time: "06:45",
      weekdays: ["monday", "wednesday"],
      destinations: ["desktop"],
    });
    expect(store.alarms[0]!.weekdays).toEqual([1, 3]);
    expect(store.alarms[0]!.date).toBeNull();
  });

  it("is honest when there's nowhere to ring, or the device is offline", async () => {
    const none = setup([]);
    const r1 = out(await none.call("time.setAlarm", { time: "07:00", day: "tomorrow" }));
    expect(JSON.stringify(r1)).toMatch(/noDestination/);
    expect((r1.created as { ringsOn: string[] }).ringsOn).toEqual([]);

    const off = setup([BROWSER]);
    const r2 = out(
      await off.call("time.setAlarm", {
        time: "07:00",
        day: "tomorrow",
        destinations: ["browser"],
      }),
    );
    expect(JSON.stringify(r2)).toMatch(/offlineNow/);
    expect(JSON.stringify(r2)).toMatch(/Chrome · Windows/);
  });

  it("a device that isn't registered is reported, never assumed", async () => {
    const { store, call } = setup([DESKTOP]);
    const r = out(
      await call("time.setAlarm", { time: "07:00", day: "tomorrow", destinations: ["browser"] }),
    );
    expect(r.notRegistered).toEqual(["browser"]);
    expect(store.alarms[0]!.destinations).toEqual([]);
  });

  it("uses the default destinations when none are named", async () => {
    const { store, call } = setup([DESKTOP]);
    store.prefs.alarmDestinations = [{ kind: "desktop", id: DESKTOP.id }];
    await call("time.setAlarm", { time: "07:00", day: "tomorrow" });
    expect(store.alarms[0]!.destinations).toEqual([{ kind: "desktop", id: DESKTOP.id }]);
  });

  it("with no default saved, the only device rings it (ADR-105)", async () => {
    const { store, call } = setup([DESKTOP]);
    await call("time.setAlarm", { time: "07:00", day: "tomorrow" });
    expect(store.alarms[0]!.destinations).toEqual([{ kind: "desktop", id: DESKTOP.id }]);
  });

  it("turns off and deletes by label", async () => {
    const { store, call } = setup([DESKTOP]);
    await call("time.setAlarm", { time: "07:00", day: "tomorrow", label: "Facultad" });
    await call("time.changeAlarm", { alarm: "facultad", enabled: false });
    expect(store.alarms[0]!.enabled).toBe(false);
    expect(store.alarms[0]!.nextFireAt).toBeNull();
    await call("time.deleteAlarm", { alarm: "facultad" });
    expect(store.alarms).toEqual([]);
  });

  it("'¿tengo alarmas hoy?' counts one that already rang today, and the screen shows them all", async () => {
    const { store, call } = setup([DESKTOP]);
    await call("time.setAlarm", { time: "13:00", day: "today", label: "Llamar a Félix" });
    await call("time.setAlarm", { time: "07:00", day: "tomorrow", label: "Facultad" });
    // It rang at 13:00 and, as a one-off, is now off (15:00 now).
    Object.assign(store.alarms[0]!, { enabled: false, state: "off", nextFireAt: null });
    const r = await call("time.listAlarms", { day: "today" });
    expect(out(r)).toMatchObject({
      count: 1,
      alarms: [{ label: "Llamar a Félix", alreadyRang: true }],
    });
    const shown = (r as { display: { alarms: { alarms: unknown[] } } }).display.alarms.alarms;
    expect(shown).toHaveLength(2);
  });
});
