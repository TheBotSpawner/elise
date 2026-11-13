import { describe, expect, it } from "vitest";

import { buildContextPackage } from "@/core/agents/context";
import { executeToolCall, type ToolCallOutcome } from "@/core/agents/executor";
import {
  canonicalHint,
  detectRepair,
  repairHint,
  repairTool,
  resolveRepairTarget,
} from "@/core/agents/repair";
import { toolNotes } from "@/core/agents/runtime";
import {
  createEventInput,
  updateEventInput,
  type CalendarEvent,
  type CalendarProvider,
  type EventPatch,
  type NewEvent,
} from "@/core/capabilities/calendar";
import { addItemsInput } from "@/core/capabilities/lists";
import { createNoteInput, updateNoteInput } from "@/core/capabilities/notes";
import { createTaskInput } from "@/core/capabilities/tasks";
import { applyAliases, findCanonicalReferences, isLiteralRequest } from "@/core/lexicon";
import { makeExternalRef } from "@/core/providers/refs";
import { describeNow } from "@/core/time";

import { binding, makeCtx, makePorts } from "../fixtures/core-fakes";

/**
 * Evaluation suite (ADR-139): spoken Rioplatense requests turned into what gets stored. As in
 * eval-rioplatense, the deterministic half of each case is checked here: what a write stores
 * given the model's arguments, which object a correction reaches, how a dictated name resolves.
 * Whether the live model writes those arguments is the live evaluation, not this file.
 */

const BA = "America/Argentina/Buenos_Aires";
const CONN = "11111111-1111-4111-8111-111111111111";

/** One-account calendar that really keeps what it is told. */
class Calendar implements Partial<CalendarProvider> {
  events = new Map<string, CalendarEvent>();
  patches: EventPatch[] = [];
  async listCalendars() {
    return [];
  }
  async listEvents() {
    return [...this.events.values()];
  }
  async busy() {
    return [];
  }
  async getEvent(id: string) {
    return this.events.get(id) ?? null;
  }
  async createEvent(e: NewEvent) {
    const n = String(this.events.size + 1);
    const start = e.start.kind === "date" ? e.start.date : `${e.start.local}:00-03:00`;
    const end = e.end.kind === "date" ? e.end.date : `${e.end.local}:00-03:00`;
    const event: CalendarEvent = {
      id: makeExternalRef(CONN, "evt", "primary", n),
      calendarId: makeExternalRef(CONN, "cal", "primary"),
      calendarName: "Primary",
      title: e.title,
      description: e.description ?? null,
      location: e.location ?? null,
      start,
      end,
      allDay: e.start.kind === "date",
      attendees: [],
      status: "confirmed",
      url: null,
      provenance: { providerKey: "google", connectionId: CONN, externalId: n, source: "Personal" },
    };
    this.events.set(event.id, event);
    return event;
  }
  async updateEvent(id: string, patch: EventPatch) {
    this.patches.push(patch);
    const event = { ...this.events.get(id)!, ...(patch.title ? { title: patch.title } : {}) };
    this.events.set(id, event);
    return event;
  }
}

function setup() {
  const calendar = new Calendar();
  const b = binding({
    connectionId: CONN,
    capability: "calendar",
    providerKey: "google",
    label: "Personal",
    isDefault: true,
  });
  const { ports } = makePorts([b], { [CONN]: calendar });
  const call = (name: string, args: unknown): Promise<ToolCallOutcome> =>
    executeToolCall(ports, makeCtx({ aiRunId: crypto.randomUUID() }), { name, args });
  return { calendar, call };
}

const after = (name: string, outcome: ToolCallOutcome) => [
  { role: "assistant", toolNotes: toolNotes([{ name, outcome } as never]) },
];

describe("titles: what a write stores, whatever module it lands in", () => {
  const titles: [string, string][] = [
    ["terminar video Grabar.ai", "Terminar video Grabar.ai"],
    ["revisar Make.com", "Revisar Make.com"],
    ["preparar informe de power automate", "Preparar informe de Power Automate"],
    ["ver el tutorial en youtube", "Ver el tutorial en YouTube"],
    ["iphone 17", "iPhone 17"],
    ["Iphone 17", "iPhone 17"],
    ["reunión con Juan, María y Pedro", "Reunión con Juan, María y Pedro"],
    ["Punto de encuentro en la estación", "Punto de encuentro en la estación"],
    ["¿llamar a Marco?", "¿Llamar a Marco?"],
  ];
  const start = "2026-11-15T10:00";
  it.each(titles)("event: %s → %s", (raw, title) => {
    expect(createEventInput.parse({ title: raw, start }).title).toBe(title);
    expect(updateEventInput.parse({ eventId: "e", title: raw }).title).toBe(title);
  });
  it.each(titles)("task: %s → %s", (raw, title) => {
    expect(createTaskInput.parse({ title: raw }).title).toBe(title);
  });
  it.each(titles)("note title: %s → %s", (raw, title) => {
    expect(createNoteInput.parse({ title: raw }).title).toBe(title);
    expect(updateNoteInput.parse({ note: "n", title: raw }).title).toBe(title);
  });

  it("a comma typed on purpose stays: no write removes one", () => {
    const title = "Leche, pan y huevos";
    expect(createTaskInput.parse({ title }).title).toBe(title);
    expect(createEventInput.parse({ title, start }).title).toBe(title);
  });

  it("several things to buy are separate items, each cleaned up", () => {
    const parsed = addItemsInput.parse({ list: "compras", items: ["leche", "pan", "huevos"] });
    expect(parsed.items).toEqual(["Leche", "Pan", "Huevos"]);
  });

  it("a note's body is never touched: lowercase, punctuation and length survive", () => {
    const content = "compré pan, leche y huevos... ¡¡por fin!!";
    expect(createNoteInput.parse({ title: "compras", content }).content).toBe(content);
    const long = "dictado largo, sin resumir. ".repeat(2000).trim();
    expect(createNoteInput.parse({ title: "dictado", content: long }).content).toBe(long);
  });
});

describe("names dictated aloud, when the user's world already spells them", () => {
  const vocabulary = ["Grabar.ai", "Make.com", "Compras"];
  const resolve = (said: string, text: string) => {
    const aliases = findCanonicalReferences(said, vocabulary).flatMap((m) =>
      m.kind === "resolved" ? [{ from: m.ref.raw, to: m.ref.resolved }] : [],
    );
    return applyAliases(text, aliases);
  };

  it.each([
    [
      "terminar video grabar punto ai",
      "Terminar video grabar punto ai",
      "Terminar video Grabar.ai",
    ],
    [
      "terminar video, grabar punto AI",
      "terminar video grabar punto AI",
      "terminar video Grabar.ai",
    ],
    ["grabar .AI para el domingo", "grabar .AI", "Grabar.ai"],
    ["agendá revisar Make punto com", "Revisar Make punto com", "Revisar Make.com"],
    ["revisar make punto com", "revisar make punto com", "revisar Make.com"],
  ])("%s", (said, written, stored) => {
    expect(resolve(said, written)).toBe(stored);
  });

  it("tells the model the name, not only the write", () => {
    const hint = canonicalHint(findCanonicalReferences("grabar punto ai", vocabulary));
    expect(hint).toContain('"Grabar.ai"');
  });

  it.each([
    "Poné literalmente punto AI en el título",
    "Creá una nota que diga exactamente: grabar punto ai",
    "anotá tal cual grabar punto ai",
  ])("%s → kept as said", (said) => {
    expect(isLiteralRequest(said)).toBe(true);
    expect(findCanonicalReferences(said, vocabulary)).toEqual([]);
  });

  it.each(["Anotá punto de encuentro en la estación", "repasar el punto dos de la agenda"])(
    "%s → punto is a word",
    (said) => {
      expect(findCanonicalReferences(said, vocabulary)).toEqual([]);
    },
  );

  it("an unknown name is never spelled for the user", () => {
    expect(findCanonicalReferences("grabar punto ai", ["Compras"])).toEqual([]);
  });
});

describe("corrections of an event", () => {
  const event = {
    title: "Terminar video, grabar Punto AI",
    start: "2026-11-15",
    location: "Estudio",
    description: "Última toma",
  };

  it("the real conversation: every correction reaches the same event, nothing else moves", async () => {
    const { calendar, call } = setup();
    let name = "calendar.createEvent";
    let outcome = await call(name, event);
    expect(outcome.status).toBe("succeeded");
    const [id] = [...calendar.events.keys()];

    const steps: [string, string][] = [
      [
        "Me refiero a Grabar punto AI, tipo literalmente un punto, no grabar punto textual",
        "Terminar video, grabar .AI",
      ],
      [
        "Grabar con la G mayúscula al comienzo y después junto con la palabra .ai, todo junto, es un nombre",
        "Terminar video, Grabar.ai",
      ],
      ["sacale la coma", "Terminar video Grabar.ai"],
    ];
    for (const [said, title] of steps) {
      const intent = detectRepair(said);
      expect(intent, said).toEqual({ kind: "correct" });
      const target = resolveRepairTarget(after(name, outcome), said);
      expect(target).toMatchObject({ kind: "one", ref: { type: "calendar_event", id } });
      expect(repairHint(intent!, target, "es")).toContain("calendar.updateEvent");
      name = "calendar.updateEvent";
      outcome = await call(name, { eventId: id, title });
      expect(outcome.status).toBe("succeeded");
    }

    expect(calendar.events.size).toBe(1);
    expect(calendar.events.get(id!)).toMatchObject({
      title: "Terminar video Grabar.ai",
      start: "2026-11-15",
      location: "Estudio",
      description: "Última toma",
      calendarName: "Primary",
    });
    for (const patch of calendar.patches)
      expect(patch).toMatchObject({ start: undefined, end: undefined, location: undefined });
  });

  it("repair tool, and the event named by its noun", async () => {
    expect(repairTool("calendar_event")).toBe("calendar.updateEvent");
    const { call } = setup();
    const outcome = await call("calendar.createEvent", { title: "Dentista", start: "2026-11-15" });
    const said = "No, sacale la coma al evento que acabás de crear";
    expect(detectRepair(said)).toEqual({ kind: "correct" });
    expect(resolveRepairTarget(after("calendar.createEvent", outcome), said).kind).toBe("one");
  });

  it("two events written together: one question, no guess", async () => {
    const { call } = setup();
    const a = await call("calendar.createEvent", { title: "Video uno", start: "2026-11-15" });
    const b = await call("calendar.createEvent", { title: "Video dos", start: "2026-11-16" });
    const history = [
      {
        role: "assistant",
        toolNotes: toolNotes([
          { name: "calendar.createEvent", outcome: a },
          { name: "calendar.createEvent", outcome: b },
        ] as never),
      },
    ];
    const target = resolveRepairTarget(history, "sacale la coma");
    expect(target.kind).toBe("ambiguous");
    expect(repairHint({ kind: "correct" }, target, "es")).toContain("Never guess");
  });

  it("a deleted event is nothing to correct", async () => {
    const { calendar, call } = setup();
    const created = await call("calendar.createEvent", { title: "Dentista", start: "2026-11-15" });
    const [id] = [...calendar.events.keys()];
    const notes = toolNotes([
      {
        name: "calendar.deleteEvent",
        outcome: {
          ...created,
          display: { kind: "event", event: calendar.events.get(id!)!, change: "deleted" },
        },
      },
    ] as never);
    expect(
      resolveRepairTarget([{ role: "assistant", toolNotes: notes }], "sacale la coma").kind,
    ).toBe("none");
  });

  it("undoing an edit never turns into deleting the event", async () => {
    const { calendar, call } = setup();
    await call("calendar.createEvent", { title: "Dentista", start: "2026-11-15" });
    const [id] = [...calendar.events.keys()];
    const moved = await call("calendar.updateEvent", { eventId: id, location: "Centro" });
    const target = resolveRepairTarget(after("calendar.updateEvent", moved), "dejalo como estaba");
    const hint = repairHint({ kind: "revert" }, target, "es")!;
    expect(hint).not.toContain("calendar.deleteEvent");
  });
});

describe("the same event twice", () => {
  const args = { title: "Terminar video", start: "2026-11-15T10:00" };

  it("a repeated request creates nothing and says so", async () => {
    const { calendar, call } = setup();
    await call("calendar.createEvent", args);
    const again = await call("calendar.createEvent", { ...args, title: "terminar video" });
    expect(calendar.events.size).toBe(1);
    expect(again).toMatchObject({ status: "succeeded", output: { created: false } });
  });

  it("the user can still ask for a second one, or the same title another day", async () => {
    const { calendar, call } = setup();
    await call("calendar.createEvent", args);
    await call("calendar.createEvent", { ...args, start: "2026-11-16T10:00" });
    await call("calendar.createEvent", { ...args, allowDuplicate: true });
    expect(calendar.events.size).toBe(3);
  });
});

describe("what is a correction and what is a new request", () => {
  it.each([
    "Me refiero a Grabar punto AI",
    "no, me refería al nombre de la marca",
    "sacale la coma",
    "sacá la coma",
    "quitale la coma",
    "sin coma",
    "poné la G mayúscula",
    "La G de Grabar va con mayúscula y punto ai todo junto",
    "con la G mayúscula",
    "todo junto, es un nombre",
  ])("%s → correction", (said) => {
    expect(detectRepair(said)).toEqual({ kind: "correct" });
  });

  it.each([
    "Agendá revisar el video, quise decir el jueves",
    "Agregame una tarea llamada Marcos con s",
    "Anotá la tarea comprar pan, todo junto",
    "Creá una nota sin coma",
    "¿Cuándo es la reunión?",
    "literalmente me olvidé de todo",
    "gracias",
  ])("%s → not a correction", (said) => {
    expect(detectRepair(said)).toBeNull();
  });
});

describe("what the model is told", () => {
  const { instructions } = buildContextPackage({
    user: { displayName: null, locale: "es", timezone: BA },
    now: new Date("2026-11-07T15:00:00Z"),
    availableCapabilities: ["calendar", "tasks", "lists", "notes"],
    history: [],
    userMessage: "x",
  });

  it.each([
    /punto ai/i, // dictated punctuation
    /punto de encuentro/i, // and the word
    /pause/i, // a recognizer's comma
    /Reunión con Juan, María y Pedro/, // a comma that belongs
    /one short question/i, // doubt about a spelling
    /hola arroba ejemplo punto com/i, // addresses go to their field
  ])("%s", (rule) => {
    expect(instructions).toMatch(rule);
  });

  it.each([
    ["2026-11-07T15:00:00Z", BA, "Saturday, 2026-11-07"],
    ["2027-11-07T15:00:00Z", BA, "Sunday, 2027-11-07"],
    ["2026-11-08T02:00:00Z", BA, "Saturday, 2026-11-07"],
    ["2026-11-08T02:00:00Z", "Europe/Madrid", "Sunday, 2026-11-08"],
  ])("dates resolve from the real day: %s in %s", (now, timezone, day) => {
    expect(describeNow(timezone, new Date(now))).toContain(day);
  });
});
