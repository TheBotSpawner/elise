import { threadUrl, type ThreadRef } from "@/core/interaction";

/**
 * The tab's active interaction (ADR-032): only its id, in sessionStorage — it survives
 * navigation and reloads, dies with the tab, and every tab has its own. Contents stay on the
 * server. Plain module (no "use client"): the root layout inlines RESUME_SCRIPT.
 */
export const ACTIVE_THREAD_KEY = "elise.activeThread";
const EVENT = "elise:active-thread";
const UUID = /^[0-9a-f-]{36}$/i;

export function parseThread(raw: string | null): ThreadRef | null {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<ThreadRef> | null;
    return v && (v.kind === "conversation" || v.kind === "session") && UUID.test(v.id ?? "")
      ? { kind: v.kind, id: v.id! }
      : null;
  } catch {
    return null;
  }
}

function raw(): string | null {
  try {
    return window.sessionStorage.getItem(ACTIVE_THREAD_KEY);
  } catch {
    return null; // storage blocked: Home simply starts fresh
  }
}

export const readActiveThread = (): ThreadRef | null => parseThread(raw());

export function rememberThread(thread: ThreadRef) {
  try {
    window.sessionStorage.setItem(
      ACTIVE_THREAD_KEY,
      JSON.stringify({ kind: thread.kind, id: thread.id }),
    );
  } catch {
    // Not remembered: Inicio opens a fresh Home.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Forgets the pointer — only if it still points at `id`, when given. */
export function forgetThread(id?: string) {
  if (id && readActiveThread()?.id !== id) return;
  try {
    window.sessionStorage.removeItem(ACTIVE_THREAD_KEY);
  } catch {
    // Nothing stored.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeActiveThread(fn: () => void) {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

/** The raw value is the snapshot (a stable string for useSyncExternalStore). */
export const activeThreadSnapshot = raw;

/** Where "Inicio" goes: the tab's active interaction, or a fresh Home. */
export const homeHref = (thread: ThreadRef | null) => (thread ? threadUrl(thread) : "/");

/**
 * Before first paint: a bare "/" in a tab with an active interaction hides Home until the
 * client opens that interaction, so a fresh Home never flashes.
 */
export const RESUME_SCRIPT = `(function(){try{if(location.pathname==="/"&&!location.search){var t=JSON.parse(sessionStorage.getItem("${ACTIVE_THREAD_KEY}")||"null");if(t&&t.id){document.documentElement.dataset.resuming="1";setTimeout(function(){delete document.documentElement.dataset.resuming},4000)}}}catch(e){}})();`;

/**
 * What arriving on Home does (ADR-032): an opened interaction becomes the tab's active one; a
 * bare "/" opens the active one again; "Nueva conversación" (`fresh`) and a vanished one
 * (`gone`) forget it. Only a bare "/" resumes: ?space=, ?run=, ?welcome= are fresh starts.
 */
export function homeArrival(input: {
  thread: ThreadRef | null;
  gone: string | null;
  fresh: boolean;
  pointer: ThreadRef | null;
  search: string;
}): {
  remember: ThreadRef | null;
  forget: "all" | string | null;
  cleanUrl: boolean;
  open: string | null;
} {
  if (input.thread) return { remember: input.thread, forget: null, cleanUrl: false, open: null };
  const forget = input.fresh ? "all" : input.gone;
  const pointer =
    forget === "all" || (forget && input.pointer?.id === forget) ? null : input.pointer;
  const cleanUrl = Boolean(input.gone || input.fresh);
  const search = cleanUrl ? "" : input.search;
  return {
    remember: null,
    forget,
    cleanUrl,
    open: pointer && !search ? threadUrl(pointer) : null,
  };
}
