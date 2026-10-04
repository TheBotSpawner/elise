// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { activeSection } from "@/components/elise/navigation/nav-items";
import { recentThreads, relativeWhen, RECENTS_LIMIT } from "@/core/history/links";
import {
  ACTIVE_THREAD_KEY,
  forgetThread,
  homeArrival,
  homeHref,
  readActiveThread,
  rememberThread,
  RESUME_SCRIPT,
} from "@/lib/active-thread";
import { I18nProvider } from "@/lib/i18n/client";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("@/features/chat/attachment-actions", () => ({
  stageAttachmentsAction: vi.fn(),
  completeAttachmentAction: vi.fn(),
  removeAttachmentAction: vi.fn(),
}));

const { NewChatButton, composerDraft, useHomeNavClick } =
  await import("@/features/chat/continuity");
const { draftAttachments } = await import("@/features/chat/draft-attachments");

const A = { kind: "conversation" as const, id: "11111111-1111-4111-8111-111111111111" };
const B = { kind: "conversation" as const, id: "22222222-2222-4222-8222-222222222222" };
const V = { kind: "session" as const, id: "33333333-3333-4333-8333-333333333333" };

beforeEach(() => {
  sessionStorage.clear();
  push.mockReset();
  composerDraft.text = "";
  delete document.documentElement.dataset.resuming;
});

describe("the tab's active conversation", () => {
  it("is remembered in sessionStorage (id only), read back, and forgotten", () => {
    expect(readActiveThread()).toBeNull();
    rememberThread(A);
    expect(JSON.parse(sessionStorage.getItem(ACTIVE_THREAD_KEY)!)).toEqual(A);
    expect(readActiveThread()).toEqual(A);
    forgetThread(B.id); // another one: kept
    expect(readActiveThread()).toEqual(A);
    forgetThread(A.id);
    expect(readActiveThread()).toBeNull();
  });

  it("ignores anything that isn't a well-formed thread", () => {
    sessionStorage.setItem(ACTIVE_THREAD_KEY, '{"kind":"conversation","id":"../../x"}');
    expect(readActiveThread()).toBeNull();
    sessionStorage.setItem(ACTIVE_THREAD_KEY, "not json");
    expect(readActiveThread()).toBeNull();
  });

  it("Inicio goes to the active conversation (or voice session), else a fresh Home", () => {
    expect(homeHref(null)).toBe("/");
    expect(homeHref(A)).toBe(`/chat/${A.id}`);
    expect(homeHref(V)).toBe(`/?session=${V.id}`);
  });

  it("a conversation in use highlights Inicio; History stays the archive", () => {
    expect(activeSection(`/chat/${A.id}`)).toBe("home");
    expect(activeSection("/")).toBe("home");
    expect(activeSection("/chat")).toBe("chat");
    expect(activeSection("/schedules/results/x")).toBe("schedules");
  });
});

describe("arriving on Home", () => {
  const base = { thread: null, gone: null, fresh: false, pointer: null, search: "" };

  it("an opened conversation (History, deep link, Recientes) becomes the active one", () => {
    expect(homeArrival({ ...base, thread: A, pointer: B })).toMatchObject({
      remember: A,
      open: null,
    });
  });

  it("a bare Home visit (navigation, reload of /) reopens the active conversation", () => {
    expect(homeArrival({ ...base, pointer: A }).open).toBe(`/chat/${A.id}`);
  });

  it("no active conversation: fresh Home, nothing created", () => {
    expect(homeArrival(base)).toEqual({
      remember: null,
      forget: null,
      cleanUrl: false,
      open: null,
    });
  });

  it("explicit fresh starts (?space=, ?run=, ?welcome=) don't resume", () => {
    expect(homeArrival({ ...base, pointer: A, search: "?space=x" }).open).toBeNull();
  });

  it("Nueva conversación forgets the active one and stays fresh", () => {
    expect(homeArrival({ ...base, fresh: true, pointer: A, search: "?new=k" })).toEqual({
      remember: null,
      forget: "all",
      cleanUrl: true,
      open: null,
    });
  });

  it("a deleted or inaccessible active conversation is forgotten, never reopened", () => {
    expect(homeArrival({ ...base, gone: A.id, pointer: A, search: `?gone=${A.id}` })).toEqual({
      remember: null,
      forget: A.id,
      cleanUrl: true,
      open: null,
    });
  });

  it("the pre-paint guard hides a bare Home only when the tab has an active conversation", () => {
    const run = () => new Function(RESUME_SCRIPT)() as void;
    run();
    expect(document.documentElement.dataset.resuming).toBeUndefined();
    rememberThread(A);
    run();
    expect(document.documentElement.dataset.resuming).toBe("1");
  });

  it("two tabs are independent: each keeps its own pointer (sessionStorage is per tab)", () => {
    // Simulated: the pointer is read only from this tab's storage, never from shared state.
    rememberThread(A);
    const otherTab = new Map([[ACTIVE_THREAD_KEY, JSON.stringify(B)]]);
    expect(readActiveThread()).toEqual(A);
    expect(JSON.parse(otherTab.get(ACTIVE_THREAD_KEY)!)).toEqual(B);
    expect(localStorage.getItem(ACTIVE_THREAD_KEY)).toBeNull();
  });
});

describe("Nueva conversación", () => {
  const renderButton = () =>
    render(
      <I18nProvider locale="es">
        <NewChatButton />
      </I18nProvider>,
    );

  it("with an empty composer starts at once: forgets the active one, nothing deleted", () => {
    rememberThread(A);
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Nueva conversación" }));
    expect(readActiveThread()).toBeNull();
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/\?new=/));
  });

  it("with typed text asks first (inline), then discards on the second press", () => {
    rememberThread(A);
    composerDraft.text = "una idea a medio escribir";
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Nueva conversación" }));
    expect(push).not.toHaveBeenCalled();
    expect(readActiveThread()).toEqual(A);
    const confirm = screen.getByRole("button", { name: "Descartar borrador y empezar otra" });
    act(() => void fireEvent.click(confirm));
    expect(push).toHaveBeenCalledTimes(1);
    expect(composerDraft.text).toBe("");
  });

  it("draft attachments count as a draft, and are discarded with it", () => {
    URL.createObjectURL = () => "blob:x";
    URL.revokeObjectURL = () => undefined;
    const remove = vi.spyOn(draftAttachments, "remove");
    draftAttachments.add([new File(["x"], "plan.pdf")]);
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: "Nueva conversación" }));
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Descartar borrador y empezar otra" }));
    expect(remove).toHaveBeenCalled();
    expect(draftAttachments.get().items).toEqual([]);
  });
});

describe("tapping Inicio again", () => {
  function HomeLink({ onHome }: { onHome: boolean }) {
    const onClick = useHomeNavClick(onHome);
    return (
      // eslint-disable-next-line @next/next/no-html-link-for-pages -- the click hook is under test, not Next's router
      <a href="/" onClick={onClick}>
        Inicio
      </a>
    );
  }
  const tap = (onHome: boolean) => {
    const { unmount } = render(<HomeLink onHome={onHome} />);
    const followed = fireEvent.click(screen.getByText("Inicio")); // false: navigation prevented
    unmount();
    return followed;
  };

  it("on Home in a conversation, starts a new one", () => {
    rememberThread(A);
    expect(tap(true)).toBe(false);
    expect(readActiveThread()).toBeNull();
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/\?new=/));
  });

  it("from another section, or with an unsent draft, it's an ordinary link", () => {
    rememberThread(A);
    expect(tap(false)).toBe(true);
    composerDraft.text = "a medio escribir";
    expect(tap(true)).toBe(true);
    expect(push).not.toHaveBeenCalled();
    expect(readActiveThread()).toEqual(A);
  });
});

describe("History · Recientes", () => {
  const row = (key: string, at: string) => ({ key, at });

  it("latest activity first across folders, whatever the list's order", () => {
    const rows = [
      row("work", "2026-10-01T10:00:00Z"),
      row("uni", "2026-10-03T09:00:00Z"),
      row("untagged", "2026-10-02T12:00:00Z"),
    ];
    expect(recentThreads(rows).map((r) => r.key)).toEqual(["uni", "untagged", "work"]);
  });

  it("is bounded", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row(`r${i}`, new Date(Date.UTC(2026, 9, 1, i)).toISOString()),
    );
    expect(recentThreads(rows)).toHaveLength(RECENTS_LIMIT);
    expect(recentThreads(rows)[0]!.key).toBe("r39");
  });

  it("says how long ago, compactly, in the user's day", () => {
    const now = new Date("2026-10-03T15:00:00Z");
    const tz = "America/Argentina/Buenos_Aires";
    expect(relativeWhen("2026-10-03T14:52:00Z", now, "es", tz)).toMatch(/8 min/);
    expect(relativeWhen("2026-10-02T15:00:00Z", now, "es", tz)).toBe("ayer");
    expect(relativeWhen("2026-09-12T15:00:00Z", now, "es", tz)).toMatch(/12 sept/);
  });
});
