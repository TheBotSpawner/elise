import { describe, expect, it } from "vitest";

import {
  assembleBrief,
  briefTopics,
  narrateBrief,
  type MorningBrief,
} from "@/core/briefs/morning-brief";
import type { HabitProgress } from "@/core/capabilities/habits";
import {
  briefExperience,
  spokenScript,
  textExperience,
  type ExperienceBlock,
} from "@/core/schedules/experience";

import { ScriptedAI } from "../../fixtures/core-fakes";

const NOW = new Date("2026-10-05T11:00:00Z"); // 08:00 in Buenos Aires
const TZ = "America/Argentina/Buenos_Aires";

const task = (id: string, title: string, dueDate: string) =>
  ({
    id,
    title,
    notes: null,
    status: "pending",
    dueDate,
    priority: "medium",
    completedAt: null,
    provenance: { providerKey: "elise_native", connectionId: "c", externalId: id, source: "ELISE" },
  }) as never;

const weather = {
  mode: "hourly" as const,
  location: { name: "Buenos Aires", detail: null, source: "configured" as const },
  timezone: TZ,
  period: null,
  current: null,
  days: [
    {
      date: "2026-10-05",
      condition: "rain" as const,
      min: 14,
      max: 22,
      precipitationProbability: 70,
      precipitationSum: 3,
      windMax: 10,
      sunrise: null,
      sunset: null,
    },
  ],
  hours: [],
  attribution: { name: "Open-Meteo", url: "https://open-meteo.com/" },
};

function brief(over: Partial<Parameters<typeof assembleBrief>[0]> = {}): MorningBrief {
  return assembleBrief({
    now: NOW,
    timezone: TZ,
    locale: "es",
    events: [],
    tasks: [
      task("t1", "Pagar factura", "2026-10-01"),
      task("t2", "Enviar propuesta", "2026-10-05"),
    ],
    weather,
    warnings: [{ block: "news", code: "SERVER_NOT_CONFIGURED" }],
    ...over,
  });
}

const kinds = (blocks: ExperienceBlock[]) => blocks.map((b) => b.kind);

describe("Scheduled Experience (Morning Brief)", () => {
  it("presents the day as segments with cards, in order, and says the empty agenda", () => {
    const x = briefExperience(brief(), "es");
    expect(x.segments.map((s) => s.id)).toEqual([
      "intro",
      "agenda",
      "tasks",
      "weather",
      "attention",
    ]);
    const agenda = x.segments.find((s) => s.id === "agenda")!;
    expect(kinds(agenda.blocks)).toEqual(["agenda"]);
    expect(agenda.say).toBe("No tenés reuniones hoy.");
    expect(x.segments.find((s) => s.id === "tasks")!.say).toBe(
      "Tenés 1 tarea para hoy y 1 vencida.",
    );
    expect(x.segments.find((s) => s.id === "weather")!.say).toMatch(
      /Entre 14 y 22 grados, con 70%/,
    );
  });

  it("omits what isn't there: no email, news, habits or finance segments without data", () => {
    const ids = briefExperience(brief(), "es").segments.map((s) => s.id);
    for (const absent of ["inbox", "news", "habits", "finance", "goals"])
      expect(ids).not.toContain(absent);
  });

  it("source problems come last, as a quiet card, and are never spoken", () => {
    const x = briefExperience(brief(), "es");
    const last = x.segments.at(-1)!;
    expect(last.id).toBe("attention");
    expect(last.say).toBeNull();
    expect(spokenScript(x).map((l) => l.segment)).not.toContain("attention");
  });

  it("habits become the weekly chart, not just counts", () => {
    const days = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-10-${String(5 + i).padStart(2, "0")}`,
      scheduled: true,
      met: i === 0,
      skipped: false,
      future: i > 0,
    }));
    const habit = {
      habitId: "h1",
      name: "Gym",
      frequency: "daily",
      unit: null,
      today: { date: days[0]!.date, scheduled: true, met: false },
      week: { done: 1, goal: 5, remaining: 4, atRisk: true, days },
      streak: { count: 0, unit: "days" },
    } as unknown as HabitProgress;
    const x = briefExperience(brief({ habits: [habit] }), "es");
    const habits = x.segments.find((s) => s.id === "habits")!;
    expect(habits.blocks[0]).toMatchObject({ kind: "chart", spec: { type: "streak" } });
  });

  it("the model's lines replace the fallback ones, only for parts on screen", () => {
    const b = brief();
    b.narration = {
      greeting: "Buen día, Leo. Día tranquilo.",
      lines: { agenda: "La agenda está libre.", weather: "Llevá paraguas a la tarde." },
      closing: "¿Arrancamos por la factura?",
    };
    const x = briefExperience(b, "es");
    expect(spokenScript(x)).toEqual([
      { segment: "intro", text: "Buen día, Leo. Día tranquilo." },
      { segment: "agenda", text: "La agenda está libre." },
      { segment: "tasks", text: "Tenés 1 tarea para hoy y 1 vencida." },
      { segment: "weather", text: "Llevá paraguas a la tarde." },
      { segment: "closing", text: "¿Arrancamos por la factura?" },
    ]);
  });

  it("older briefs keep their written summary as the transcript", () => {
    const b = brief();
    b.narrative = "**Hoy** tenés poco.";
    expect(briefExperience(b, "es").transcript).toBe("**Hoy** tenés poco.");
  });

  it("a text-only run is the same model: one text segment", () => {
    const x = textExperience("Recordatorio: llamar al banco.", "2026-10-05", TZ);
    expect(x.segments).toEqual([
      {
        id: "text",
        label: null,
        say: null,
        blocks: [{ kind: "text", markdown: "Recordatorio: llamar al banco." }],
      },
    ]);
  });
});

describe("narration", () => {
  it("keeps only lines for parts the brief has; the model can't add a topic", async () => {
    const b = brief();
    const ai = new ScriptedAI([
      () => [
        {
          type: "text_delta",
          delta: JSON.stringify({
            greeting: "Buen día.",
            lines: { agenda: "Libre.", news: "Inventada.", tasks: "" },
            closing: null,
          }),
        },
      ],
    ]);
    const n = await narrateBrief(ai, b, { userName: "Leo", locale: "es", instructions: null });
    expect(briefTopics(b)).toEqual(["agenda", "tasks", "weather"]);
    expect(n).toEqual({ greeting: "Buen día.", lines: { agenda: "Libre." }, closing: null });
    const sent = ai.requests[0]!.input[0] as { content: string };
    expect(JSON.parse(sent.content).topics).toEqual(["agenda", "tasks", "weather"]);
  });

  it("unusable model output → null (the experience speaks its own lines)", async () => {
    const ai = new ScriptedAI([() => [{ type: "text_delta", delta: "Hola! Hoy tenés..." }]]);
    expect(
      await narrateBrief(ai, brief(), { userName: null, locale: "es", instructions: null }),
    ).toBeNull();
  });
});
