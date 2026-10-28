import { describe, expect, it } from "vitest";

import { quickRead } from "@/core/agents/quick-reads";

const ok = (output: unknown) => ({ status: "succeeded", output }) as never;

describe("quick reads (ADR-123)", () => {
  it("plain questions about alarms and timers are read without the model", () => {
    expect(quickRead("tengo alguna alarma hoy?")?.calls).toEqual([
      { name: "time.listAlarms", args: { day: "today" } },
    ]);
    expect(quickRead("¿Tengo alarmas para mañana?")?.calls[0]?.args).toEqual({ day: "tomorrow" });
    expect(quickRead("¿qué alarmas activas tengo?")?.calls[0]?.args).toEqual({});
    expect(quickRead("cómo van mis timers")?.calls[0]?.name).toBe("time.list");
  });

  it("'¿qué tareas tengo hoy?' is one read of what's open", () => {
    for (const m of [
      "¿Qué tareas tengo hoy?",
      "Elis, ¿tengo tareas para hoy?",
      "mis tareas de hoy",
      "¿qué tareas tengo pendientes?",
    ])
      expect(quickRead(m)?.calls, m).toEqual([{ name: "tasks.list", args: { limit: 100 } }]);
  });

  it("changes, details, specific searches and long requests go to the model", () => {
    for (const m of [
      // Setting one, said tersely: never a read (the model sets it).
      "timer dos horas",
      "timer de 10 minutos",
      "un temporizador de media hora para la pasta",
      "alarma a las 7",
      "alarma mañana a las ocho",
      "pomodoro",
      "poneme una alarma a las 7",
      "apagá la alarma de las 13",
      "desactivá todas las alarmas",
      "pará el timer",
      "¿dónde suena la alarma?",
      "cambiá el sonido de la alarma",
      "tengo alarmas hoy y si no ponéme una a las siete de la tarde para ir al gimnasio",
      "¿qué tengo hoy?",
      "¿tengo la tarea de llamar a Félix?",
      "¿qué tareas tengo para mañana?",
      "planificame las tareas de hoy",
      "agregá una tarea para hoy",
    ])
      expect(quickRead(m), m).toBeNull();
  });

  it("answers alarms from the result, saying which already rang", () => {
    const q = quickRead("tengo alguna alarma hoy?")!;
    const rang = {
      day: "2026-10-27",
      alarms: [
        {
          label: "Llamar a Félix",
          time: "13:00",
          enabled: false,
          nextRing: null,
          alreadyRang: true,
        },
      ],
    };
    expect(q.answer([ok(rang)], "es", "2026-10-27")).toBe(
      "Sí, una: a las 13:00 (Llamar a Félix), que ya sonó. No te queda ninguna más.",
    );
    expect(q.answer([ok({ day: "2026-10-27", alarms: [] })], "es", "2026-10-27")).toBe(
      "No, no tenés alarmas para ese día.",
    );
    // A failed read is the model's to explain.
    expect(q.answer([{ status: "failed" } as never], "es", "2026-10-27")).toBeNull();
  });

  it("lists active alarms and how many are off", () => {
    const q = quickRead("mis alarmas")!;
    const all = {
      alarms: [
        { label: "Facultad", time: "07:00", enabled: true, nextRing: "2026-10-28T07:00" },
        { label: null, time: "16:00", enabled: false, nextRing: null },
      ],
    };
    expect(q.answer([ok(all)], "es", "2026-10-27")).toBe(
      "Tenés una alarma activa: a las 07:00 (Facultad). Otra está apagada.",
    );
  });

  it("answers tasks for today, with the overdue ones and a cap on what's said aloud", () => {
    const TODAY = "2026-10-27";
    const t = (title: string, dueDate: string | null) => ({ title, dueDate });
    const open = (...ts: ReturnType<typeof t>[]) => [ok({ tasks: ts })];
    const q = quickRead("¿qué tareas tengo hoy?")!;
    expect(
      q.answer(
        open(
          t("Enviar factura", "2026-10-25"),
          t("Pagar la luz", TODAY),
          t("Llamar a Félix", TODAY),
          t("Algún día", null),
        ),
        "es",
        TODAY,
      ),
    ).toBe(
      "Para hoy tenés 2 tareas: Pagar la luz y Llamar a Félix. Además, una vencida: Enviar factura.",
    );
    expect(q.answer(open(t("Mañana", "2026-10-28")), "es", TODAY)).toBe(
      "Para hoy no tenés tareas.",
    );
    const many = open(...Array.from({ length: 8 }, (_, i) => t(`T${i + 1}`, TODAY)));
    expect(q.answer(many, "es", TODAY)).toBe(
      "Para hoy tenés 8 tareas: T1, T2, T3, T4, T5, T6 y 2 más.",
    );
    expect(quickRead("mis tareas pendientes")!.answer(open(t("A", null)), "es", TODAY)).toBe(
      "Tenés una tarea pendiente: A.",
    );
  });
});
