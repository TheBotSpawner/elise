import { describe, expect, it } from "vitest";

import {
  describeRepeat,
  nextAfterCompletion,
  nextOccurrence,
  parseRRule,
  repeatSchema,
  toRRule,
  type Repeat,
} from "@/core/tasks/recurrence";

/** ADR-115: recurring tasks — a date-only RRULE subset, one live occurrence at a time. */

const r = (x: Partial<Repeat> & Pick<Repeat, "freq">): Repeat => repeatSchema.parse(x);

describe("nextOccurrence", () => {
  it("daily and every N days", () => {
    expect(nextOccurrence(r({ freq: "daily" }), "2026-10-23", "2026-10-23")).toBe("2026-10-24");
    expect(nextOccurrence(r({ freq: "daily", interval: 3 }), "2026-10-23", "2026-10-24")).toBe(
      "2026-10-26",
    );
  });

  it("weekly on chosen days, and every 2 weeks", () => {
    // 2026-10-23 is a Friday.
    const monThu = r({ freq: "weekly", days: ["mo", "th"] });
    expect(nextOccurrence(monThu, "2026-10-23", "2026-10-23")).toBe("2026-10-26");
    expect(nextOccurrence(monThu, "2026-10-23", "2026-10-26")).toBe("2026-10-29");
    const biweekly = r({ freq: "weekly", interval: 2 });
    expect(nextOccurrence(biweekly, "2026-10-23", "2026-10-23")).toBe("2026-11-06");
  });

  it("weekdays skip the weekend", () => {
    const wd = r({ freq: "weekly", days: ["mo", "tu", "we", "th", "fr"] });
    expect(nextOccurrence(wd, "2026-10-23", "2026-10-23")).toBe("2026-10-26");
  });

  it("monthly by day, clamped to the month's last day", () => {
    const on31 = r({ freq: "monthly", monthDay: 31 });
    expect(nextOccurrence(on31, "2026-01-31", "2026-01-31")).toBe("2026-02-28");
    expect(nextOccurrence(on31, "2026-01-31", "2026-02-28")).toBe("2026-03-31");
    const last = r({ freq: "monthly", monthDay: -1 });
    expect(nextOccurrence(last, "2026-10-31", "2026-10-31")).toBe("2026-11-30");
  });

  it("monthly by ordinal weekday", () => {
    const secondTue = r({ freq: "monthly", ordinal: { n: 2, day: "tu" } });
    expect(nextOccurrence(secondTue, "2026-10-13", "2026-10-13")).toBe("2026-11-10");
    const lastFri = r({ freq: "monthly", ordinal: { n: -1, day: "fr" } });
    expect(nextOccurrence(lastFri, "2026-10-30", "2026-10-30")).toBe("2026-11-27");
  });

  it("yearly, 29 Feb in a common year is 28 Feb", () => {
    expect(nextOccurrence(r({ freq: "yearly" }), "2028-02-29", "2028-02-29")).toBe("2029-02-28");
  });

  it("UNTIL ends the series", () => {
    expect(
      nextOccurrence(r({ freq: "daily", until: "2026-10-24" }), "2026-10-23", "2026-10-24"),
    ).toBeNull();
  });

  it("dates only: a DST change can't move them (America/Santiago, Europe/Madrid)", () => {
    // Madrid moves its clocks on 2026-10-25; the date series is unaffected.
    expect(nextOccurrence(r({ freq: "daily" }), "2026-10-24", "2026-10-24")).toBe("2026-10-25");
    expect(nextOccurrence(r({ freq: "daily" }), "2026-10-24", "2026-10-25")).toBe("2026-10-26");
  });
});

describe("nextAfterCompletion", () => {
  it("skips occurrences already in the past", () => {
    expect(
      nextAfterCompletion(r({ freq: "daily" }), "2026-10-01", "2026-10-01", "2026-10-23", 1),
    ).toBe("2026-10-23");
  });
  it("COUNT reached ends it", () => {
    expect(
      nextAfterCompletion(
        r({ freq: "daily", count: 3 }),
        "2026-10-21",
        "2026-10-23",
        "2026-10-23",
        3,
      ),
    ).toBeNull();
  });
});

describe("RRULE", () => {
  it("round-trips the supported subset", () => {
    for (const x of [
      r({ freq: "weekly", interval: 2, days: ["mo", "th"] }),
      r({ freq: "monthly", ordinal: { n: -1, day: "fr" }, count: 6 }),
      r({ freq: "monthly", monthDay: 15, until: "2027-03-01" }),
      r({ freq: "yearly" }),
    ])
      expect(parseRRule(toRRule(x))).toEqual(x);
    expect(toRRule(r({ freq: "weekly", interval: 2, days: ["th", "mo"] }))).toBe(
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH",
    );
  });
  it("refuses what it can't honour", () => {
    expect(() => parseRRule("FREQ=HOURLY")).toThrow();
    expect(() => repeatSchema.parse({ freq: "daily", count: 3, until: "2027-01-01" })).toThrow();
  });
});

describe("describeRepeat", () => {
  it("says it the Rioplatense way", () => {
    expect(
      describeRepeat(r({ freq: "weekly", days: ["mo", "tu", "we", "th", "fr"] }), null, "es"),
    ).toBe("Días hábiles");
    expect(describeRepeat(r({ freq: "weekly", interval: 2, days: ["mo", "th"] }), null, "es")).toBe(
      "Cada 2 semanas, los lunes y jueves",
    );
    expect(describeRepeat(r({ freq: "monthly", ordinal: { n: 2, day: "tu" } }), null, "es")).toBe(
      "Todos los meses, el segundo martes",
    );
    expect(describeRepeat(r({ freq: "monthly" }), "2026-10-15", "es")).toBe(
      "Todos los meses, el día 15",
    );
    expect(describeRepeat(r({ freq: "daily", count: 10 }), null, "en")).toBe(
      "Every day · 10 times",
    );
  });
});
