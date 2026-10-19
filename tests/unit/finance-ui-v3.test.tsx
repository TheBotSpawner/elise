// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinanceCategory } from "@/core/capabilities/finance";
import { I18nProvider } from "@/lib/i18n/client";

/**
 * Finance v3 on screen (ADR-083): categories save as you go (in order, latest wins), duplicates
 * are refused inline, the emoji picker confirms with ✓, a long press starts selecting, a
 * right-click opens ELISE's own menu.
 */
const calls = vi.hoisted(() => ({ tool: vi.fn() }));
vi.mock("@/features/finance/actions", () => ({
  financeToolAction: calls.tool,
  categoryUsageAction: vi.fn(async () => ({
    ok: true,
    value: { transactions: 3, budgets: 0, children: 0 },
  })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { CategoryManager } = await import("@/features/finance/category-manager");
const { MovementMenu, useLongPress } = await import("@/features/finance/movement-menu");
const { EmojiPicker } = await import("@/components/ui/emoji-picker");

// jsdom's <dialog> lacks showModal/close.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
};

const wrap = (ui: React.ReactNode) => render(<I18nProvider locale="es">{ui}</I18nProvider>);
const cats: FinanceCategory[] = [
  { id: "c1", name: "Entretenimiento", type: "expense", parentId: null, parent: null, icon: null },
  { id: "c2", name: "Regalos", type: "expense", parentId: null, parent: null, icon: null },
  { id: "c3", name: "Regalos", type: "income", parentId: null, parent: null, icon: null },
];

beforeEach(() => {
  calls.tool.mockReset();
  calls.tool.mockResolvedValue({ ok: true, value: undefined });
});

describe("categories", () => {
  it("rename saves by itself after a pause (no Guardar button), with the cleaned name", async () => {
    vi.useFakeTimers();
    wrap(<CategoryManager open onClose={() => undefined} categories={cats} />);
    expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
    const input = screen.getByRole("textbox", { name: "Nombre: Entretenimiento" });
    fireEvent.change(input, { target: { value: "  Oc" } });
    fireEvent.change(input, { target: { value: "  Ocio " } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(calls.tool).toHaveBeenCalledTimes(1); // one request, not one per keystroke
    expect(calls.tool).toHaveBeenCalledWith("finance.updateCategory", {
      category: "c1",
      name: "Ocio",
    });
    vi.useRealTimers();
  });

  it("leaving the field saves at once; a slower earlier save never overwrites a newer name", async () => {
    let release!: () => void;
    calls.tool.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ ok: true, value: undefined }))),
    );
    wrap(<CategoryManager open onClose={() => undefined} categories={cats} />);
    const input = screen.getByRole("textbox", { name: "Nombre: Entretenimiento" });
    fireEvent.change(input, { target: { value: "Ocio" } });
    fireEvent.blur(input);
    await vi.waitFor(() => expect(calls.tool).toHaveBeenCalledTimes(1)); // "Ocio", still in flight
    fireEvent.change(input, { target: { value: "Salidas" } });
    fireEvent.blur(input);
    expect(calls.tool).toHaveBeenCalledTimes(1); // waits its turn
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(calls.tool).toHaveBeenCalledTimes(2));
    expect(calls.tool.mock.calls.map((c) => (c[1] as { name: string }).name)).toEqual([
      "Ocio",
      "Salidas",
    ]);
  });

  it("a duplicate in the same type is refused inline and reverts; creating one is blocked", () => {
    wrap(<CategoryManager open onClose={() => undefined} categories={cats} />);
    const input = screen.getByRole("textbox", { name: "Nombre: Entretenimiento" });
    fireEvent.change(input, { target: { value: "regalos" } });
    expect(screen.getByRole("alert").textContent).toBe(
      "Ya existe una categoría “Regalos” en Gastos.",
    );
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("Entretenimiento");
    expect(calls.tool).not.toHaveBeenCalled();

    const create = screen.getByPlaceholderText(/Supermercado/);
    fireEvent.change(create, { target: { value: "  REGALOS " } });
    expect(screen.getByRole("button", { name: /Crear/ }).hasAttribute("disabled")).toBe(true);
  });

  it("a failed save restores the saved name and says so", async () => {
    calls.tool.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "",
        retryable: false,
        recovery: "none",
        referenceId: "",
      },
    });
    wrap(<CategoryManager open onClose={() => undefined} categories={cats} />);
    const input = screen.getByRole("textbox", { name: "Nombre: Entretenimiento" });
    fireEvent.change(input, { target: { value: "Ocio" } });
    fireEvent.blur(input);
    await vi.waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/No pudimos guardar/),
    );
    expect((input as HTMLInputElement).value).toBe("Entretenimiento");
  });
});

describe("emoji picker", () => {
  it("confirms a typed emoji with ✓ (never a second emoji button); ZWJ emoji accepted", () => {
    const onChange = vi.fn();
    wrap(<EmojiPicker value="" onChange={onChange} label="Ícono" />);
    fireEvent.click(screen.getByRole("button", { name: "Ícono" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "🧑🏻‍🍳" } });
    const confirm = screen.getByRole("button", { name: "Usar" });
    expect(confirm.textContent).toBe("");
    expect(confirm.querySelector("svg")).not.toBeNull();
    fireEvent.click(confirm);
    expect(onChange).toHaveBeenCalledWith("🧑🏻‍🍳");
  });
});

describe("selection gestures", () => {
  it("a long press selects (and swallows its tap); moving to scroll cancels it", () => {
    vi.useFakeTimers();
    const onLong = vi.fn();
    const { result } = renderHook(() => useLongPress(onLong));
    const ev = (x: number, y: number, pointerType = "touch") =>
      ({ clientX: x, clientY: y, pointerType }) as never;
    result.current.onPointerDown(ev(10, 10));
    vi.advanceTimersByTime(600);
    expect(onLong).toHaveBeenCalledTimes(1);
    expect(result.current.consumeClick()).toBe(true);
    expect(result.current.consumeClick()).toBe(false);

    result.current.onPointerDown(ev(10, 10));
    result.current.onPointerMove(ev(10, 40)); // a scroll
    vi.advanceTimersByTime(600);
    expect(onLong).toHaveBeenCalledTimes(1);

    result.current.onPointerDown(ev(10, 10, "mouse")); // mice never long-press
    vi.advanceTimersByTime(600);
    expect(onLong).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("right-click menu: Seleccionar / Quitar de la selección, Editar, Duplicar, Eliminar; Escape closes", () => {
    const fns = {
      onClose: vi.fn(),
      onToggleSelect: vi.fn(),
      onEdit: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
    };
    const { rerender } = wrap(
      <MovementMenu state={{ x: 10, y: 10, selected: false, editable: true }} {...fns} />,
    );
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Seleccionar",
      "Editar",
      "Duplicar",
      "Eliminar",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Seleccionar" }));
    expect(fns.onToggleSelect).toHaveBeenCalled();
    rerender(
      <I18nProvider locale="es">
        <MovementMenu state={{ x: 10, y: 10, selected: true, editable: true }} {...fns} />
      </I18nProvider>,
    );
    expect(screen.getByRole("menuitem", { name: "Quitar de la selección" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(fns.onClose).toHaveBeenCalled();
  });
});

describe("several Ámbitos per movement (ADR-087)", () => {
  it("Editar movimiento: toggle Ámbitos and save them all", async () => {
    const { TransactionDialog } = await import("@/features/finance/transaction-dialog");
    calls.tool.mockReset().mockResolvedValue({ ok: true, value: null });
    const book = (id: string, name: string) =>
      ({ id, name, type: "personal", icon: null, isDefault: id === "p" }) as never;
    const tx = {
      id: "t1",
      type: "income",
      amount: "844968.88",
      currency: "ARS",
      date: "2026-10-06",
      description: "Pago RSFA P2",
      counterparty: null,
      category: null,
      categoryId: null,
      categoryPath: [],
      subcategory: null,
      account: null,
      accountId: null,
      paymentMethod: null,
      project: null,
      status: "completed",
      notes: null,
      importId: null,
      bookId: "p",
      book: "Personal",
      bookIds: ["p"],
      books: ["Personal"],
      readOnly: false,
    } as never;
    wrap(
      <TransactionDialog
        open
        onClose={vi.fn()}
        transaction={tx}
        accounts={[]}
        categories={cats}
        books={[book("p", "Personal"), book("f", "Firbot")]}
        defaultCurrency="ARS"
        today="2026-10-18"
      />,
    );
    const personal = screen.getByRole("button", { name: /Personal/ });
    const firbot = screen.getByRole("button", { name: /Firbot/ });
    expect(personal.getAttribute("aria-pressed")).toBe("true");
    expect(firbot.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(firbot);
    expect(firbot.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    expect(calls.tool).toHaveBeenCalledWith(
      "finance.updateTransaction",
      expect.objectContaining({ transaction: "t1", books: ["Personal", "Firbot"] }),
    );
  });
});
