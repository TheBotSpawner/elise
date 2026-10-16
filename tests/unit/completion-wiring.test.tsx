// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useNative } from "@/features/native/use-native";
import { SurfaceBody } from "@/features/workspace/surfaces";
import { I18nProvider } from "@/lib/i18n/client";

// ── Where the UI calls it ────────────────────────────────────────────────────

const feedback = vi.hoisted(() => ({ completionFeedback: vi.fn(), primeCompletionSound: vi.fn() }));
vi.mock("@/features/feedback/completion", () => feedback);

const nativeAction = vi.hoisted(() => vi.fn());
vi.mock("@/features/native/actions", () => ({ nativeActionAction: nativeAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => vi.clearAllMocks());

describe("goals: felt when the server confirms the completion", () => {
  async function run(tool: string, args: unknown, ok: boolean) {
    cleanup();
    nativeAction.mockResolvedValue(
      ok ? { ok: true } : { ok: false, error: { code: "INTERNAL_ERROR" } },
    );
    function Probe() {
      const { act: run } = useNative();
      return <button onClick={() => run(tool, args)}>go</button>;
    }
    render(
      <I18nProvider locale="es">
        <Probe />
      </I18nProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("go"));
    });
  }

  it("goals.complete succeeded → one goal completion", async () => {
    await run("goals.complete", { goal: "g1" }, true);
    expect(feedback.primeCompletionSound).toHaveBeenCalledOnce();
    expect(feedback.completionFeedback).toHaveBeenCalledOnce();
    expect(feedback.completionFeedback.mock.calls[0]![0]).toMatchObject({
      kind: "goal",
      key: "goal:g1",
    });
  });

  it("a failed completion, or a progress update, plays nothing", async () => {
    await run("goals.complete", { goal: "g1" }, false);
    await run("goals.updateProgress", { goal: "g1", value: 7 }, true);
    expect(feedback.completionFeedback).not.toHaveBeenCalled();
  });
});

describe("tasks on the Canvas", () => {
  async function renderTasks(status: "pending" | "completed") {
    cleanup();
    const onAction = vi.fn();
    const surface = {
      id: "s",
      handle: "S1",
      type: "task_list",
      title: "Hoy",
      state: "ready",
      priority: 50,
      size: "medium",
      source: null,
      ref: null,
      payload: {
        items: [
          {
            id: "t1",
            title: "Renovar el pasaporte",
            status,
            dueDate: null,
            listName: "Personal",
            source: "ELISE",
            priority: null,
          },
        ],
        total: 1,
      },
      actions: [],
      intentId: null,
      turn: 1,
      createdAt: "",
      updatedAt: "",
    };
    const view = render(
      <I18nProvider locale="es">
        <SurfaceBody
          surface={surface as never}
          timezone="UTC"
          handlers={{ onAction, pending: null, busy: false } as never}
        />
      </I18nProvider>,
    );
    return { onAction, view };
  }

  it("checking a task completes it through the action and gives feedback once", async () => {
    const { onAction } = await renderTasks("pending");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onAction).toHaveBeenCalledWith(expect.anything(), "complete", "t1");
    expect(feedback.completionFeedback).toHaveBeenCalledOnce();
    expect(feedback.completionFeedback.mock.calls[0]![0]).toMatchObject({
      kind: "task",
      key: "task:t1",
    });
  });

  it("a task that arrives already completed (refetch, realtime, Chat) plays nothing", async () => {
    await renderTasks("completed");
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(feedback.completionFeedback).not.toHaveBeenCalled();
  });
});
