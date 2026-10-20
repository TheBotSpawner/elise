import { describe, expect, it } from "vitest";

import { toLocalDateTime } from "@/core/time";
import {
  deliveryCheck,
  dueDecision,
  localInstant,
  nextFire,
  sniffAudio,
  soundOf,
  stillRinging,
} from "@/core/timers/alarms";

/**
 * Alarms (ADR-100): the server's clock and the user's IANA timezone decide when an alarm
 * fires — never the model, never a browser tab.
 */
const BA = "America/Argentina/Buenos_Aires";
const NY = "America/New_York";
const local = (d: Date, tz: string) => toLocalDateTime(d, tz);

describe("when an alarm fires", () => {
  it("a one-off alarm tomorrow at 07:00 in Buenos Aires", () => {
    const now = new Date("2026-10-19T21:00:00Z"); // Monday 18:00 in Buenos Aires
    const at = nextFire({ time: "07:00", date: "2026-10-20", weekdays: [], timezone: BA }, now)!;
    expect(at.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    expect(local(at, BA)).toBe("2026-10-20T07:00");
    // Once it has passed, a one-off alarm has no next time.
    expect(
      nextFire({ time: "07:00", date: "2026-10-20", weekdays: [], timezone: BA }, at),
    ).toBeNull();
  });

  it("Mondays and Wednesdays at 06:45: the next one, then the one after", () => {
    const a = { time: "06:45", date: null, weekdays: [1, 3], timezone: BA };
    const monday = new Date("2026-10-19T12:00:00Z"); // Monday 09:00, past 06:45
    const first = nextFire(a, monday)!;
    expect(local(first, BA)).toBe("2026-10-21T06:45"); // Wednesday
    expect(local(nextFire(a, first)!, BA)).toBe("2026-10-26T06:45"); // next Monday
    expect(nextFire({ ...a, weekdays: [] }, monday)).toBeNull();
  });

  it("DST: a skipped time rings at the first minute that exists; a repeated hour rings once", () => {
    // New York springs forward on 8 Mar 2026 at 02:00 → 03:00.
    const skipped = localInstant("2026-03-08", "02:30", NY);
    expect(local(skipped, NY)).toBe("2026-03-08T03:00");
    // It falls back on 1 Nov 2026 at 02:00 → 01:00: 01:30 happens twice; the first one rings.
    const repeated = localInstant("2026-11-01", "01:30", NY);
    expect(repeated.toISOString()).toBe("2026-11-01T05:30:00.000Z"); // EDT, the earlier one
    // A daily alarm keeps its wall time across the change.
    const daily = { time: "07:00", date: null, weekdays: [0, 1, 2, 3, 4, 5, 6], timezone: NY };
    const sat = nextFire(daily, new Date("2026-03-07T13:00:00Z"))!;
    expect(local(sat, NY)).toBe("2026-03-08T07:00");
    expect(local(nextFire(daily, sat)!, NY)).toBe("2026-03-09T07:00");
  });

  it("found due: on time or a little late rings; much later is missed (no catch-up storm)", () => {
    const at = new Date("2026-10-20T10:00:00Z");
    expect(dueDecision(at, new Date("2026-10-20T09:59:00Z"))).toBe("early");
    expect(dueDecision(at, new Date("2026-10-20T10:10:00Z"))).toBe("ring");
    expect(dueDecision(at, new Date("2026-10-20T11:00:00Z"))).toBe("missed");
  });

  it("a ringing alarm stops by itself after ten minutes, everywhere", () => {
    const since = new Date("2026-10-20T10:00:00Z");
    expect(stillRinging(since, new Date("2026-10-20T10:09:00Z"))).toBe(true);
    expect(stillRinging(since, new Date("2026-10-20T10:10:00Z"))).toBe(false);
  });
});

describe("where an alarm rings", () => {
  const known = [
    { kind: "browser" as const, id: "b1", name: "Chrome", online: true, lastSeenAt: "x" },
    { kind: "desktop" as const, id: "d1", name: "PC", online: false, lastSeenAt: "y" },
  ];
  it("only what the user chose: ready, registered but offline, or unknown — never a default", () => {
    const r = deliveryCheck(
      [
        { kind: "browser", id: "b1" },
        { kind: "desktop", id: "d1" },
        { kind: "desktop", id: "gone" },
      ],
      known,
    );
    expect(r.ready.map((x) => x.id)).toEqual(["b1"]);
    expect(r.offline.map((x) => x.id)).toEqual(["d1"]);
    expect(r.unknown).toEqual([{ kind: "desktop", id: "gone" }]);
    expect(deliveryCheck([], known)).toEqual({ ready: [], offline: [], unknown: [] });
  });
});

describe("sounds", () => {
  it("an alarm's own sound, else the user's default, else ELISE's", () => {
    expect(soundOf({ sound: "campana" }, "pulso")).toBe("campana");
    expect(soundOf({ sound: null }, "pulso")).toBe("pulso");
    expect(soundOf({ sound: null }, null)).toBe("brisa");
  });

  it("an upload is recognized by its first bytes, never by its name", () => {
    const b = (s: string, pad = 16) =>
      new Uint8Array([...Buffer.from(s), ...new Array(pad).fill(0)]);
    expect(sniffAudio(b("ID3"))).toBe("audio/mpeg");
    expect(sniffAudio(b("OggS"))).toBe("audio/ogg");
    expect(sniffAudio(new Uint8Array([...Buffer.from("RIFF0000WAVE"), 0, 0]))).toBe("audio/wav");
    expect(sniffAudio(new Uint8Array([0, 0, 0, 0, ...Buffer.from("ftypM4A "), 0]))).toBe(
      "audio/mp4",
    );
    expect(sniffAudio(b("<html><script>"))).toBeNull();
    expect(sniffAudio(new Uint8Array([1, 2]))).toBeNull();
  });
});
