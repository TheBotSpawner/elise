// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Orb } from "@/components/elise/orb/orb";
import { ORB_STATES } from "@/components/elise/orb/orb-states";
import { I18nProvider } from "@/lib/i18n/client";

describe("Orb", () => {
  it.each(ORB_STATES)("announces the %s state accessibly", (state) => {
    render(
      <I18nProvider locale="en">
        <Orb state={state} />
      </I18nProvider>,
    );
    expect(screen.getByRole("img")).toHaveAccessibleName(/elise|done/i);
  });

  it("speaks Spanish when the locale is es", () => {
    render(
      <I18nProvider locale="es">
        <Orb state="waiting_approval" />
      </I18nProvider>,
    );
    expect(screen.getByRole("img", { name: "Elise espera tu aprobación" })).toBeInTheDocument();
  });
});
