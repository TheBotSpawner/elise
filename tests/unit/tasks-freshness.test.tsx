// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildContextPackage } from "@/core/agents/context";
import { isStale, useRefreshWhenStale } from "@/hooks/use-refresh-when-stale";
import { GoogleHttp } from "@/infrastructure/providers/google/http";
import { GoogleTasksProvider, type GTask } from "@/infrastructure/providers/google/tasks";

/**
 * Google Tasks is the source of truth (ADR-009, ADR-046): ELISE reads it live, writes through,
 * and re-reads when data is about to be trusted. There is no push from Google to rely on.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function google(connectionId: string, remote: { lists: string[]; tasks: Record<string, GTask[]> }) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/users/@me/lists"))
      return Response.json({ items: remote.lists.map((id) => ({ id, title: id })) });
    const list = /\/lists\/([^/]+)\/tasks/.exec(url)?.[1] ?? "";
    if (init?.method === "PATCH") {
      const id = url.split("/").at(-1)!;
      const body = JSON.parse(String(init.body)) as Partial<GTask>;
      const task = remote.tasks[list]!.find((t) => t.id === id)!;
      Object.assign(task, body);
      return Response.json(task);
    }
    const showCompleted = url.includes("showCompleted=true");
    return Response.json({
      items: (remote.tasks[list] ?? []).filter((t) => showCompleted || t.status !== "completed"),
    });
  });
  const provider = new GoogleTasksProvider(
    { connectionId, label: connectionId === A ? "Personal" : "Firbot" },
    new GoogleHttp({ accessToken: async () => "t" }, fetchImpl),
  );
  return { provider, calls };
}

describe("Google Tasks stays the source of truth", () => {
  it("every read reflects what changed in Google: created, completed, renamed, re-dated, deleted", async () => {
    const remote = {
      lists: ["L1"],
      tasks: {
        L1: [
          {
            id: "t1",
            title: "Informe RSFA",
            status: "needsAction",
            due: "2026-10-06T00:00:00.000Z",
          },
          { id: "t2", title: "Llamar a Rod", status: "needsAction" },
          { id: "t3", title: "Borrar esto", status: "needsAction" },
        ] as GTask[],
      },
    };
    const { provider } = google(A, remote);
    expect(
      (await provider.list({ status: "open", limit: 500 })).map((t) => t.title).sort(),
    ).toEqual(["Borrar esto", "Informe RSFA", "Llamar a Rod"]);
    // Changed directly in Google Tasks:
    remote.tasks.L1[0]!.title = "Informe RSFA v2";
    remote.tasks.L1[0]!.due = "2026-10-08T00:00:00.000Z";
    remote.tasks.L1[1]!.status = "completed";
    remote.tasks.L1[2]!.deleted = true;
    remote.tasks.L1.push({ id: "t4", title: "Nueva desde Google", status: "needsAction" });
    const open = await provider.list({ status: "open", limit: 500 });
    expect(open.map((t) => [t.title, t.dueDate])).toEqual([
      ["Informe RSFA v2", "2026-10-08"],
      ["Nueva desde Google", null],
    ]);
    const completed = await provider.list({ status: "completed", limit: 50 });
    expect(completed.map((t) => t.title)).toEqual(["Llamar a Rod"]);
    // Uncompleted in Google: back in the open view on the next read.
    remote.tasks.L1[1]!.status = "needsAction";
    expect((await provider.list({ status: "open", limit: 500 })).map((t) => t.title)).toContain(
      "Llamar a Rod",
    );
  });

  it("a mutation from ELISE is written to Google and the result is Google's answer", async () => {
    const remote = {
      lists: ["L1"],
      tasks: { L1: [{ id: "t1", title: "X", status: "needsAction" }] as GTask[] },
    };
    const { provider, calls } = google(A, remote);
    const [task] = await provider.list({ status: "open", limit: 10 });
    const done = await provider.complete(task!.id);
    expect(calls.some((c) => c.startsWith("PATCH") && c.includes("/lists/L1/tasks/t1"))).toBe(true);
    expect(remote.tasks.L1[0]!.status).toBe("completed");
    expect(done.status).toBe("completed");
    // The next read agrees with Google: nothing stale is kept anywhere.
    expect(await provider.list({ status: "open", limit: 10 })).toEqual([]);
  });

  it("reading never writes: no copy into ELISE Native is made", async () => {
    const { provider, calls } = google(A, {
      lists: ["L1"],
      tasks: { L1: [{ id: "t", title: "Y" }] },
    });
    await provider.list({ status: "open", limit: 10 });
    expect(calls.every((c) => c.startsWith("GET https://tasks.googleapis.com"))).toBe(true);
  });

  it("identity is provider identity: same title in two accounts are two tasks", async () => {
    const same = () => ({
      lists: ["L1"],
      tasks: { L1: [{ id: "t1", title: "Pagar AFIP" }] as GTask[] },
    });
    const [a] = await google(A, same()).provider.list({ status: "open", limit: 10 });
    const [b] = await google(B, same()).provider.list({ status: "open", limit: 10 });
    expect(a!.title).toBe(b!.title);
    expect(a!.id).not.toBe(b!.id);
    expect([a!.provenance.connectionId, b!.provenance.connectionId]).toEqual([A, B]);
    expect(a!.provenance).toMatchObject({
      providerKey: "google",
      externalId: "t1",
      source: "Personal",
    });
  });

  it("pages through every list (pagination is not regressed)", async () => {
    let page = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/users/@me/lists")) return Response.json({ items: [{ id: "L1" }] });
      page++;
      return Response.json(
        url.includes("pageToken=n")
          ? { items: [{ id: "b", title: "B" }] }
          : { items: [{ id: "a", title: "A" }], nextPageToken: "n" },
      );
    });
    const provider = new GoogleTasksProvider(
      { connectionId: A, label: "Personal" },
      new GoogleHttp({ accessToken: async () => "t" }, fetchImpl),
    );
    expect((await provider.list({ status: "open", limit: 500 })).map((t) => t.title)).toEqual([
      "A",
      "B",
    ]);
    expect(page).toBe(2);
  });
});

describe("refresh when the data is about to be trusted", () => {
  afterEach(() => vi.useRealTimers());

  it("a fresh server render is trusted; a snapshot older than 30 s is not", () => {
    expect(isStale(1_000, 20_000)).toBe(false);
    expect(isStale(1_000, 40_000)).toBe(true);
    expect(isStale(Number.NaN, 0)).toBe(true);
  });

  it("opening a cached (stale) page refreshes it once; a fresh one is not refetched", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    const refresh = vi.fn();
    renderHook(() => useRefreshWhenStale("2026-10-06T12:00:00Z", refresh));
    expect(refresh).not.toHaveBeenCalled();
    renderHook(() => useRefreshWhenStale("2026-10-06T11:58:00Z", refresh));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("coming back to the tab after a while refreshes; a quick glance or a busy loop doesn't", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    const refresh = vi.fn();
    renderHook(() => useRefreshWhenStale("2026-10-06T12:00:00Z", refresh));
    vi.setSystemTime(new Date("2026-10-06T12:00:10Z"));
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(refresh).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-10-06T12:05:00Z"));
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => void window.dispatchEvent(new Event("focus")));
    // Once per snapshot: the refreshed render brings a new fetchedAt.
    expect(refresh).toHaveBeenCalledTimes(1);
    // Nothing polls in the background.
    vi.advanceTimersByTime(60 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("chat re-reads tasks before answering instead of trusting what's on screen", () => {
    const ctx = buildContextPackage({
      user: { displayName: null, locale: "es", timezone: "America/Argentina/Buenos_Aires" },
      now: new Date("2026-10-06T12:00:00Z"),
      availableCapabilities: ["tasks"],
      history: [],
      userMessage: "¿Qué tareas tengo para hoy?",
    });
    expect(ctx.instructions).toContain("call tasks.list again in this turn before answering");
  });
});
