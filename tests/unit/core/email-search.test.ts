import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { EmailQuery } from "@/core/capabilities/email";
import { mentionsDay, searchLadder } from "@/core/capabilities/email-search";

import { binding, InMemoryEmailProvider, makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * Finding the email (ADR-099), from a real miss: on Monday 19 Oct the user asked for "un correo
 * para hoy de la clase de Análisis de Sistemas". The notice ("…Actividades para el Lunes
 * 19/10") arrived on Saturday 17 and says "Actividades", not "clase".
 */
const UTN = "44444444-4444-4444-8444-444444444444";

const fold = (x: string) => x.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/** Searches like Gmail: every word must be there, and dates are when a message arrived. */
class LiteralEmail extends InMemoryEmailProvider {
  override async search(q: EmailQuery) {
    return this.messages
      .filter((m) => {
        const hay = fold(`${m.subject} ${m.snippet} ${m.from?.name ?? ""} ${m.from?.email ?? ""}`);
        const words = q.text ? fold(q.text).split(/\s+/).filter(Boolean) : [];
        if (!words.every((w) => hay.includes(w))) return false;
        if (q.from && !fold(`${m.from?.name ?? ""} ${m.from?.email ?? ""}`).includes(fold(q.from)))
          return false;
        const at = Date.parse(m.date);
        if (q.after && at < q.after.getTime()) return false;
        if (q.before && at >= q.before.getTime()) return false;
        return true;
      })
      .map((m) => ({ ...m, body: null }));
  }
}

function setup() {
  const utn = new LiteralEmail(UTN, "UTN", "leo@frba.utn.edu.ar");
  utn.addMessage({
    id: "aviso",
    threadId: "t-aviso",
    subject: "2026 - Análisis de Sistemas de Información K2131: Actividades para el Lunes 19/10",
    snippet: "Les recordamos que nos vemos el lunes 19/10 presencialmente en Medrano.",
    from: {
      name: "Sol Abril Neira (vía Facultad Regional Buenos Aires)",
      email: "noreply-aulasvirtuales@frba.utn.edu.ar",
    },
    date: "2026-10-17T19:07:00.000Z",
  });
  const { ports } = makePorts(
    [
      binding({
        connectionId: UTN,
        capability: "email",
        providerKey: "google",
        label: "UTN",
        accountLabel: "leo@frba.utn.edu.ar",
        isDefault: true,
      }),
    ],
    { [UTN]: utn },
  );
  return { ports };
}

const ctx = () => makeCtx({ now: new Date("2026-10-19T21:38:00Z") });

describe("email search finds the notice for a day", () => {
  it("aboutDay looks at the two weeks before, and says which day each message is about", async () => {
    const { ports } = setup();
    const out = await executeToolCall(ports, ctx(), {
      name: "email.search",
      args: { text: "Análisis de Sistemas", aboutDay: "2026-10-19" },
    });
    expect(out.status).toBe("succeeded");
    const o = (out as { output: { count: number; messages: { mentionsAboutDay: boolean }[] } })
      .output;
    expect(o.count).toBe(1);
    expect(o.messages[0]!.mentionsAboutDay).toBe(true);
    // The same notice is NOT about Tuesday.
    const tue = await executeToolCall(ports, ctx(), {
      name: "email.search",
      args: { text: "Análisis de Sistemas", aboutDay: "2026-10-20" },
    });
    expect(
      (tue as { output: { messages: { mentionsAboutDay: boolean }[] } }).output.messages[0]!
        .mentionsAboutDay,
    ).toBe(false);
  });

  it("the request's own words and a too-narrow date are retried, and said", async () => {
    const { ports } = setup();
    const out = await executeToolCall(ports, ctx(), {
      name: "email.search",
      // What the model did: request words in text, the delivery date = the class date.
      args: { text: "clase análisis de sistemas hoy", after: "2026-10-19" },
    });
    const o = (out as { output: { count: number; searchRelaxed: string[] } }).output;
    expect(o.count).toBe(1);
    expect(o.searchRelaxed).toEqual(["generic_words", "wider_dates"]);
  });
});

describe("the retry ladder", () => {
  it("is the request first, then each relaxation in order", () => {
    const steps = searchLadder({ text: "correo de la clase", from: "UTN", after: "2026-10-19" });
    expect(steps.map((s) => s.relaxed.at(-1) ?? "as_asked")).toEqual([
      "as_asked",
      "generic_words",
      "wider_dates",
      "sender_as_text",
    ]);
    expect(steps[3]!.query).toMatchObject({ from: undefined, after: "2026-10-05" });
  });

  it("knows how a day is written", () => {
    for (const t of ["Actividades para el Lunes 19/10", "el 19 de octubre", "Monday 19", "Oct 19"])
      expect(mentionsDay(t, "2026-10-19")).toBe(true);
    expect(mentionsDay("Actividades para el Lunes 19/10", "2026-10-20")).toBe(false);
    expect(mentionsDay("Aula 119/105", "2026-10-19")).toBe(false);
  });
});
