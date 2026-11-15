// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SurfaceBody } from "@/features/workspace/surfaces";
import { I18nProvider } from "@/lib/i18n/client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe("an all-day event shows its own day", () => {
  it.each(["America/Argentina/Buenos_Aires", "Pacific/Auckland"])(
    "30 Nov stays 30 Nov in %s",
    (timezone) => {
      render(
        <I18nProvider locale="es">
          <SurfaceBody
            surface={
              {
                id: "s",
                type: "calendar_event",
                payload: {
                  title: "Entrega de notas de Análisis de Sistemas",
                  start: "2026-11-30",
                  end: "2026-12-01",
                  allDay: true,
                  attendees: [],
                  location: null,
                },
              } as never
            }
            timezone={timezone}
            handlers={{ onAction: vi.fn(), pending: null, busy: false } as never}
          />
        </I18nProvider>,
      );
      expect(screen.getAllByText(/lun, 30 nov/).length).toBeGreaterThan(0);
      expect(screen.queryByText(/29 nov/)).toBeNull();
    },
  );
});
