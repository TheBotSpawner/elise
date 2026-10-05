// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ScheduledExperience } from "@/core/schedules/experience";
import { ExperienceView } from "@/features/schedules/experience-view";
import { I18nProvider } from "@/lib/i18n/client";

// ELISE's voice, faked: records what is said and lets the test finish each line.
const said: string[] = [];
let idle: (() => void) | null = null;
vi.mock("@/features/voice/speech-player", () => ({
  SpeechPlayer: class {
    onIdle: (() => void) | null = null;
    onError: (() => void) | null = null;
    speak(text: string) {
      said.push(text);
      idle = () => this.onIdle?.();
    }
    prepare() {}
    stop() {}
    close() {}
  },
}));

Element.prototype.scrollIntoView = vi.fn();

const experience: ScheduledExperience = {
  version: 1,
  date: "2026-10-05",
  timezone: "America/Argentina/Buenos_Aires",
  transcript: null,
  segments: [
    { id: "intro", label: null, say: "Buen día. Día tranquilo.", blocks: [] },
    {
      id: "agenda",
      label: "Agenda",
      say: "No tenés reuniones hoy.",
      blocks: [{ kind: "agenda", span: "today", events: [], conflicts: [], gaps: [] }],
    },
    {
      id: "tasks",
      label: "Tareas",
      say: "Tenés una vencida.",
      blocks: [
        {
          kind: "tasks",
          due: [],
          overdue: [
            {
              id: "t1",
              title: "Pagar factura",
              dueDate: "2026-10-01",
              priority: "medium",
              source: "ELISE",
            },
          ],
        },
      ],
    },
  ],
};

const view = (narrate = true) =>
  render(
    <I18nProvider locale="es">
      <ExperienceView
        experience={experience}
        title="Morning Brief"
        eyebrow="lunes"
        narrate={narrate}
      />
    </I18nProvider>,
  );

describe("Scheduled Experience view", () => {
  it("renders ELISE's lines with their cards: the agenda card says there are no meetings", () => {
    view();
    // Said in the segment, and again in the (collapsed) transcript.
    expect(screen.getAllByText("No tenés reuniones hoy.")).toHaveLength(2);
    expect(screen.getByText("Sin reuniones hoy")).toBeTruthy();
    expect(screen.getByText("Pagar factura")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Escuchar" })).toBeTruthy();
  });

  it("Escuchar speaks segment by segment and highlights the one being said", () => {
    said.length = 0;
    view();
    fireEvent.click(screen.getByRole("button", { name: "Escuchar" }));
    const current = () => document.querySelector("[aria-current=step]")?.textContent ?? "";
    expect(said).toEqual(["Buen día. Día tranquilo."]);
    expect(current()).toContain("Buen día");
    act(() => idle?.());
    expect(said.at(-1)).toBe("No tenés reuniones hoy.");
    expect(current()).toContain("Sin reuniones hoy");
    act(() => idle?.());
    act(() => idle?.());
    expect(said).toHaveLength(3);
    expect(current()).toBe("");
    expect(screen.getByRole("button", { name: "Escuchar" })).toBeTruthy();
  });

  it("in a chat reply only the cards show (the conversation does the talking)", () => {
    view(false);
    expect(screen.queryByText("No tenés reuniones hoy.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Escuchar" })).toBeNull();
    expect(screen.getByText("Sin reuniones hoy")).toBeTruthy();
  });
});
