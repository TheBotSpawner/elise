// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { InfoTip } from "@/components/shared/info-tip";
import { Dialog } from "@/components/ui/dialog";
import { I18nProvider } from "@/lib/i18n/client";

beforeAll(() => {
  // jsdom has <dialog> without showModal/close.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});

/**
 * A dialog inside another (the emoji picker inside Categorías, ADR-075): React passes the inner
 * one's close/cancel up the component tree, which used to close the outer one too.
 */
describe("nested dialogs", () => {
  it("closing or escaping the inner one leaves the outer one open", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <I18nProvider locale="es">
        <Dialog open onClose={outer} title="Categorías">
          <Dialog open onClose={inner} title="Ícono">
            <p>picker</p>
          </Dialog>
        </Dialog>
      </I18nProvider>,
    );
    const pickerDialog = screen.getByText("picker").closest("dialog")!;
    fireEvent(pickerDialog, new Event("close"));
    fireEvent(pickerDialog, new Event("cancel", { cancelable: true }));
    expect(inner).toHaveBeenCalledTimes(2);
    expect(outer).not.toHaveBeenCalled();
  });

  it("an info tip inside a dialog opens inside it (never behind the modal)", () => {
    render(
      <I18nProvider locale="es">
        <Dialog open onClose={vi.fn()} title="Editar Morning Brief">
          <InfoTip label="Acerca de Correos" body={["Solo los importantes."]} />
        </Dialog>
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Acerca de Correos" }));
    const tip = screen.getByRole("tooltip");
    expect(tip.closest("dialog")).not.toBeNull();
  });
});
