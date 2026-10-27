import { describe, expect, it } from "vitest";

import { quickRead } from "@/core/agents/quick-reads";

const ok = (output: unknown) => ({ status: "succeeded", output }) as never;

describe("quick reads (ADR-123)", () => {
  it("plain questions about alarms and timers are read without the model", () => {
    expect(quickRead("tengo alguna alarma hoy?")?.call).toEqual({
      name: "time.listAlarms",
      args: { day: "today" },
    });
    expect(quickRead("¿Tengo alarmas para mañana?")?.call.args).toEqual({ day: "tomorrow" });
    expect(quickRead("¿qué alarmas activas tengo?")?.call.args).toEqual({});
    expect(quickRead("cómo van mis timers")?.call.name).toBe("time.list");
  });

  it("changes, details and long requests go to the model", () => {
    for (const m of [
      "poneme una alarma a las 7",
      "apagá la alarma de las 13",
      "desactivá todas las alarmas",
      "pará el timer",
      "¿dónde suena la alarma?",
      "cambiá el sonido de la alarma",
      "tengo alarmas hoy y si no ponéme una a las siete de la tarde para ir al gimnasio",
      "¿qué tengo hoy?",
    ])
      expect(quickRead(m), m).toBeNull();
  });

  it("answers from the result, saying which already rang", () => {
    const q = quickRead("tengo alguna alarma hoy?")!;
    expect(
      q.answer(
        ok({
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
        }),
        "es",
      ),
    ).toBe("Sí, una: a las 13:00 (Llamar a Félix), que ya sonó. No te queda ninguna más.");
    expect(q.answer(ok({ day: "2026-10-27", alarms: [] }), "es")).toBe(
      "No, no tenés alarmas para ese día.",
    );
    // A failed read is the model's to explain.
    expect(q.answer({ status: "failed" } as never, "es")).toBeNull();
  });

  it("lists active alarms and how many are off", () => {
    const q = quickRead("mis alarmas")!;
    expect(
      q.answer(
        ok({
          alarms: [
            { label: "Facultad", time: "07:00", enabled: true, nextRing: "2026-10-28T07:00" },
            { label: null, time: "16:00", enabled: false, nextRing: null },
          ],
        }),
        "es",
      ),
    ).toBe("Tenés una alarma activa: a las 07:00 (Facultad). Otra está apagada.");
  });
});
