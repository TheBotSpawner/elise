// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Ambient } from "@/features/chat/chat-surface";
import { I18nProvider } from "@/lib/i18n/client";

/**
 * Home's "Continuar" line is a one-line preview that the row's width truncates with an ellipsis;
 * the other items keep their size, and the link still opens the same conversation.
 */

const LONG =
  "Elis, porfa, ¿me agregás, este... pará que estoy pensando... huevos, leche, el pan integral que siempre compro, y acordate de que el jueves tengo que llamar a Marco por el tema del presupuesto de Firbot, que quedó pendiente desde la semana pasada y no quiero que se me pase otra vez.";

function home(description: string) {
  return render(
    <I18nProvider locale="es">
      <Ambient
        ambient={{
          dueToday: 2,
          overdue: 3,
          pendingApprovals: 0,
          brief: { id: "b1", read: false },
          resume: { thread: { kind: "conversation", id: "c1" }, description },
        }}
      />
    </I18nProvider>,
  );
}

describe("Home: Continuar preview", () => {
  it("a long voice transcript stays one line, truncated, with the full text on hover", () => {
    home(LONG);
    const link = screen.getByRole("link", { name: /Continuar:/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("c1"));
    const preview = screen.getByText(/^Elis, porfa/);
    // One line, ellipsis, shrinks to the room left (CSS: no character count decides it).
    expect(preview.className).toContain("truncate");
    expect(preview.className).toContain("min-w-0");
    expect(link).toHaveAttribute("title", expect.stringContaining("presupuesto de Firbot"));
    // The label "Continuar:" never shrinks; the preview is quieter than it.
    expect(screen.getByText("Continuar:").className).toContain("shrink-0");
    expect(preview.className).toContain("text-faint");
  });

  it("a short message is shown whole; Hoy and Vencidas never shrink", () => {
    home("agregá huevos");
    expect(screen.getByText("agregá huevos")).toBeInTheDocument();
    for (const item of screen.getAllByRole("listitem")) {
      if (item.textContent?.includes("Continuar:")) expect(item.className).toContain("min-w-0");
      else expect(item.className).toMatch(/shrink-0|^flex h-8 items-center$/);
    }
  });

  it("never stores more than a bounded preview in the page", () => {
    home("x".repeat(5000));
    const text = screen.getByRole("link", { name: /Continuar:/ }).getAttribute("title") ?? "";
    expect(text.length).toBeLessThanOrEqual(300);
  });
});
