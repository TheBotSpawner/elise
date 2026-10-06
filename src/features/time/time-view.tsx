"use client";

import {
  Flag,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Timer as TimerIcon,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import {
  clockText,
  currentPhase,
  elapsedMs,
  isActive,
  remainingMs,
  type TimerKind,
} from "@/core/timers/model";
import { timerFromPayload, type ClockPayload, type TimerPayload } from "@/core/workspace/time";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { createClient } from "@/infrastructure/supabase/client";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { loadTimers, timeAction } from "./actions";
import { playChime, unlockAudioOnGesture } from "./sound";
import { activeTimers, nearest, timeStore, useLiveTimer, useTick, useTime } from "./store";

/**
 * Native Time on screen (ADR-045). Every number here is computed from the timer's timestamps
 * on each tick; nothing counts down in state. The Surfaces, the mini timer and the Focus view
 * all read the same store, which follows the server through Realtime.
 */

type Size = "micro" | "small" | "medium" | "large" | "focus";

function useT() {
  return useI18n().t.time;
}

// ── Reading a timer ──────────────────────────────────────────────────────────

function view(p: TimerPayload, now: Date) {
  const t = timerFromPayload(p);
  const phase = currentPhase(t);
  const stopwatch = t.kind === "stopwatch";
  const left = remainingMs(t, now);
  const shown = stopwatch ? elapsedMs(t, now) : left;
  return {
    t,
    phase,
    stopwatch,
    digits: clockText(shown, !stopwatch),
    progress: stopwatch || !t.durationMs ? 0 : Math.min(1, Math.max(0, 1 - left / t.durationMs)),
    running: t.state === "running",
    active: isActive(t),
    // A Pomodoro waiting at the start of its next phase.
    waiting: t.state === "paused" && Boolean(phase) && left === t.durationMs,
  };
}

async function act(input: Parameters<typeof timeAction>[0]) {
  const r = await timeAction(input);
  if (!r.ok) return void toast.error(r.error.message);
  if (r.timer) timeStore.upsert(r.timer);
}

// ── Controls ─────────────────────────────────────────────────────────────────

function Btn({
  label,
  onClick,
  primary,
  big,
  children,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  big?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center justify-center gap-1.5 rounded-full text-[13px] font-medium transition-colors",
        big ? "h-12 min-w-12 px-4 md:h-14 md:min-w-14" : "h-9 min-w-9 px-3",
        primary
          ? "bg-fg text-bg hover:opacity-90"
          : "border border-border text-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function Controls({ p, big, compact }: { p: TimerPayload; big?: boolean; compact?: boolean }) {
  const t = useT();
  const now = timeStore.now();
  const v = view(p, now);
  if (!v.active)
    return v.t.kind !== "stopwatch" && p.state === "completed" ? (
      <div className="flex gap-2">
        <Btn
          big={big}
          label={t.restart}
          onClick={() => void act({ tool: "control", action: "reset", timer: p.id })}
        >
          <RotateCcw className="size-4" aria-hidden /> {t.restart}
        </Btn>
      </div>
    ) : null;
  const icon = big ? "size-5" : "size-4";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Btn
        big={big}
        primary
        label={v.running ? t.pause : v.waiting ? t.startPhase : t.resume}
        onClick={() =>
          void act({ tool: "control", action: v.running ? "pause" : "resume", timer: p.id })
        }
      >
        {v.running ? <Pause className={icon} aria-hidden /> : <Play className={icon} aria-hidden />}
        {v.waiting && <span>{t.startPhase}</span>}
      </Btn>
      {v.stopwatch ? (
        <>
          <Btn
            big={big}
            label={t.lap}
            onClick={() => void act({ tool: "control", action: "lap", timer: p.id })}
          >
            <Flag className={icon} aria-hidden />
          </Btn>
          <Btn
            big={big}
            label={t.reset}
            onClick={() => void act({ tool: "control", action: "reset", timer: p.id })}
          >
            <RotateCcw className={icon} aria-hidden />
          </Btn>
        </>
      ) : (
        <>
          {!compact && (
            <Btn
              big={big}
              label={t.plus(1)}
              onClick={() => void act({ tool: "addTime", minutes: 1, timer: p.id })}
            >
              +1m
            </Btn>
          )}
          <Btn
            big={big}
            label={t.plus(5)}
            onClick={() => void act({ tool: "addTime", minutes: 5, timer: p.id })}
          >
            +5m
          </Btn>
          {p.pomodoro && !compact && (
            <Btn
              big={big}
              label={t.skip}
              onClick={() => void act({ tool: "control", action: "skip", timer: p.id })}
            >
              <SkipForward className={icon} aria-hidden />
            </Btn>
          )}
        </>
      )}
      <Btn
        big={big}
        label={t.cancel}
        onClick={() => void act({ tool: "control", action: "cancel", timer: p.id })}
      >
        <X className={icon} aria-hidden />
      </Btn>
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function kindLabel(t: ReturnType<typeof useT>, kind: TimerKind) {
  return kind === "pomodoro" ? t.pomodoro : kind === "stopwatch" ? t.stopwatch : t.timer;
}

function Eyebrow({ p, v }: { p: TimerPayload; v: ReturnType<typeof view> }) {
  const t = useT();
  const status =
    p.state === "completed"
      ? t.completed
      : p.state === "cancelled"
        ? t.cancelled
        : v.waiting
          ? t.waiting
          : p.state === "paused"
            ? t.paused
            : null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] tracking-[0.14em] text-faint uppercase">
      <span className={cn(v.phase?.phase === "focus" && "text-accent")}>
        {v.phase ? t.phases[v.phase.phase] : kindLabel(t, p.kind)}
      </span>
      {v.phase && p.pomodoro && <span>· {t.cycle(v.phase.cycle, p.pomodoro.cycles)}</span>}
      {status && <span className="text-approval-text">· {status}</span>}
    </p>
  );
}

function Ring({
  progress,
  children,
  big,
}: {
  progress: number;
  children: React.ReactNode;
  big?: boolean;
}) {
  const r = 46;
  const c = 2 * Math.PI * r;
  return (
    <div
      className={cn(
        "relative mx-auto aspect-square",
        big ? "w-[min(70vmin,520px)]" : "w-[min(100%,280px)]",
      )}
    >
      <svg viewBox="0 0 100 100" className="absolute inset-0 size-full -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={r} fill="none" className="stroke-border" strokeWidth="1.5" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          className="stroke-accent transition-[stroke-dashoffset] duration-1000 ease-linear"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - progress)}
        />
      </svg>
      {/* A size container: the digits inside scale with the ring (see ringDigits). */}
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-1"
        style={{ containerType: "inline-size" }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Digits always keep a margin inside the ring: a mono digit is ~0.6em wide, so n characters at
 * 100/n % of the ring's width fill ~60% of it ("25:00" stops at 18%; "10:00:00" gets 12.5%).
 */
const ringDigits = (text: string) => `min(18cqw, ${(100 / text.length).toFixed(2)}cqw)`;

/** The Focus view: as large as the screen allows, never wider than ~75% of it. */
const focusDigits = (text: string) => `min(240px, 20vw, ${(120 / text.length).toFixed(2)}vw, 28vh)`;

// ── The Timer Surface ────────────────────────────────────────────────────────

export function TimerSurfaceBody({ p: snapshot, size }: { p: TimerPayload; size: Size }) {
  const t = useT();
  const p = useLiveTimer(snapshot);
  const now = useTick(p.state === "running");
  const v = view(p, now);

  if (size === "micro" || size === "small")
    return (
      <div className="flex flex-col gap-2">
        <Eyebrow p={p} v={v} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-[28px] leading-none font-light tabular-nums">{v.digits}</p>
          <Controls p={p} compact />
        </div>
      </div>
    );

  if (size === "focus")
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 py-4 text-center">
        <Eyebrow p={p} v={v} />
        <p
          className="font-mono leading-none font-extralight tracking-tight tabular-nums"
          style={{ fontSize: focusDigits(v.digits) }}
        >
          {v.digits}
        </p>
        {!v.stopwatch && (
          <div className="h-1 w-[min(560px,80vw)] overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear"
              style={{ width: `${v.progress * 100}%` }}
            />
          </div>
        )}
        <Controls p={p} big />
        <Laps p={p} />
      </div>
    );

  return (
    <div className="flex flex-col items-center gap-4 py-1">
      <div className="self-start">
        <Eyebrow p={p} v={v} />
      </div>
      {v.stopwatch ? (
        <p className="py-6 font-mono text-[56px] leading-none font-light tabular-nums">
          {v.digits}
        </p>
      ) : (
        <Ring progress={v.progress}>
          <p
            className="font-mono leading-none font-light tabular-nums"
            style={{ fontSize: ringDigits(v.digits) }}
          >
            {v.digits}
          </p>
          <p className="text-[12px] text-faint">{p.state === "running" ? t.remaining : ""}</p>
        </Ring>
      )}
      <Controls p={p} />
      <Laps p={p} />
    </div>
  );
}

function Laps({ p }: { p: TimerPayload }) {
  const t = useT();
  if (!p.laps.length) return null;
  return (
    <ol className="w-full max-w-xs space-y-1 text-[13px] text-muted">
      {p.laps
        .map((at, i) => ({ at, i, split: at - (p.laps[i - 1] ?? 0) }))
        .reverse()
        .slice(0, 8)
        .map((l) => (
          <li key={l.i} className="flex justify-between font-mono tabular-nums">
            <span>
              {t.lap} {l.i + 1}
            </span>
            <span>+{clockText(l.split, false)}</span>
            <span className="text-fg">{clockText(l.at, false)}</span>
          </li>
        ))}
    </ol>
  );
}

// ── The Clock Surface ────────────────────────────────────────────────────────

export function ClockSurfaceBody({ p, size }: { p: ClockPayload; size: Size }) {
  const { locale } = useI18n();
  const now = useTick(true);
  const tag = locale === "es" ? "es-AR" : "en-US";
  const time = new Intl.DateTimeFormat(tag, {
    timeZone: p.timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: p.hour12,
  }).format(now);
  const date = new Intl.DateTimeFormat(tag, {
    timeZone: p.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);
  const big = size === "focus" || size === "large";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        size === "focus" && "min-h-[60vh]",
      )}
    >
      <p
        className={cn(
          "font-mono leading-none font-extralight tracking-tight tabular-nums",
          size === "focus" ? "text-[clamp(72px,20vw,240px)]" : big ? "text-[72px]" : "text-[44px]",
        )}
      >
        {time}
      </p>
      <p className="text-[14px] text-muted first-letter:uppercase">
        {date}
        {p.place ? ` · ${p.place}` : ""}
      </p>
    </div>
  );
}

// ── Global: mini timer, list, Focus view ─────────────────────────────────────

function MiniTimer() {
  const t = useT();
  const s = useTime();
  const active = activeTimers(s.timers);
  const now = useTick(active.some((x) => x.state === "running"));
  const [open, setOpen] = useState(false);
  const first = nearest(s.timers, now);
  if (!first) return null;
  const v = view(first, now);
  return (
    <div className="fixed bottom-4 left-4 z-40 flex flex-col items-start gap-2">
      {open && (
        <div className="w-[min(340px,calc(100vw-32px))] rounded-2xl border border-border bg-[var(--menu-bg)] p-3 shadow-xl backdrop-blur">
          <ul className="flex flex-col divide-y divide-border">
            {active.map((x) => (
              <MiniRow key={x.id} p={x} />
            ))}
          </ul>
          <NotifyHint />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-11 items-center gap-2 rounded-full border border-border bg-[var(--menu-bg)] px-4 text-[14px] shadow-lg backdrop-blur hover:bg-surface-2"
      >
        <TimerIcon className={cn("size-4", v.running ? "text-accent" : "text-faint")} aria-hidden />
        <span className="font-mono tabular-nums">{v.digits}</span>
        <span className="max-w-[40vw] truncate text-muted">
          · {active.length > 1 ? t.count(active.length) : (first.label ?? kindLabel(t, first.kind))}
        </span>
      </button>
    </div>
  );
}

function MiniRow({ p }: { p: TimerPayload }) {
  const t = useT();
  const now = useTick(p.state === "running");
  const v = view(p, now);
  return (
    <li className="flex items-center justify-between gap-2 py-2">
      <button
        type="button"
        onClick={() => timeStore.focus(p.id)}
        className="flex min-w-0 flex-col items-start text-left"
        title={t.showLarge}
      >
        <span className="truncate text-[13px] text-muted">
          {p.label ?? kindLabel(t, p.kind)}
          {v.phase ? ` · ${t.phases[v.phase.phase]}` : ""}
        </span>
        <span className={cn("font-mono text-[20px] tabular-nums", !v.running && "text-faint")}>
          {v.digits}
        </span>
      </button>
      <div className="flex items-center gap-1">
        <Controls p={p} compact />
        <button
          type="button"
          aria-label={t.showLarge}
          onClick={() => timeStore.focus(p.id)}
          className="flex size-9 items-center justify-center rounded-full text-faint hover:bg-surface-2 hover:text-fg"
        >
          <Maximize2 className="size-4" aria-hidden />
        </button>
      </div>
    </li>
  );
}

function FocusOverlay() {
  const t = useT();
  const s = useTime();
  const p = s.timers.find((x) => x.id === s.focusId);
  useEffect(() => {
    if (!p) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && timeStore.focus(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);
  if (!p) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={p.label ?? kindLabel(t, p.kind)}
      className="fixed inset-0 z-50 flex flex-col bg-bg"
    >
      <div className="flex items-center justify-between px-4 pt-4 md:px-8">
        <p className="truncate text-[15px] text-muted">{p.label ?? kindLabel(t, p.kind)}</p>
        <button
          type="button"
          aria-label={t.close}
          onClick={() => timeStore.focus(null)}
          className="flex size-11 items-center justify-center rounded-full text-faint hover:bg-surface-2 hover:text-fg"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center px-4">
        <TimerSurfaceBody p={p} size="focus" />
      </div>
    </div>
  );
}

const noop = () => () => undefined;
function NotifyHint() {
  const t = useT();
  const s = useTime();
  const permission = useSyncExternalStore(
    noop,
    () => ("Notification" in window ? Notification.permission : "unsupported"),
    () => "default",
  );
  const [asked, setAsked] = useState<string | null>(null);
  const now = asked ?? permission;
  if (!s.prefs.notify || now === "granted" || now === "unsupported") return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2 text-[12.5px] text-muted">
      <p className="min-w-0 flex-1">{now === "denied" ? t.notifyBlocked : t.notifyHint}</p>
      {now === "default" && (
        <button
          type="button"
          className="rounded-full border border-border px-3 py-1 text-fg hover:bg-surface-2"
          onClick={() => void Notification.requestPermission().then(setAsked)}
        >
          {t.enableNotify}
        </button>
      )}
    </div>
  );
}

// ── The controller: load, follow, finish ─────────────────────────────────────

/** Completions already announced in this tab ("timerId:at"). */
const announced = new Set<string>();

/**
 * Mounted once for every page. Keeps the store in step with the server (load, Realtime,
 * returning to the tab), and when a timer ends: chime (if this browser allows sound), a toast,
 * and a browser notification when ELISE isn't in view. Its own end-of-timer check only asks the
 * server to settle; the server decides that a timer completed, exactly once.
 */
export function TimeController({ workspaceId, userId }: { workspaceId: string; userId: string }) {
  const tr = useI18n().t.time;
  const labels = useRef(tr);
  useEffect(() => {
    labels.current = tr;
  });

  const announce = useCallback(
    (timerId: string, at: string, title: string | null, browser: boolean) => {
      const key = `${timerId}:${at}`;
      // Only fresh completions sound (coming back hours later shows, but doesn't ring).
      if (announced.has(key) || Date.now() - Date.parse(at) > 120_000) return;
      announced.add(key);
      const s = timeStore.get();
      const timer = s.timers.find((x) => x.id === timerId);
      const text = title ?? labels.current.done(timer?.label ?? labels.current.timer);
      const rang = playChime(s.prefs.sound);
      toast(text, {
        description: rang ? undefined : labels.current.soundBlocked,
        action: { label: labels.current.showLarge, onClick: () => timeStore.focus(timerId) },
      });
      if (
        browser &&
        document.visibilityState === "hidden" &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        // Same tag in every tab and device of this browser: shown once.
        const n = new Notification(text, { tag: key });
        n.onclick = () => {
          window.focus();
          timeStore.focus(timerId);
        };
      }
    },
    [],
  );

  const reload = useCallback(async () => {
    const before = timeStore.get().timers;
    const r = await loadTimers();
    if (!r.ok) return;
    timeStore.load(r.timers, r.prefs, r.serverNow);
    // Realtime may be down: anything that ended since the last look is announced from here too.
    for (const old of before) {
      const now = r.timers.find((x) => x.id === old.id);
      if (
        old.state === "running" &&
        old.endsAt &&
        now &&
        now.version !== old.version &&
        Date.parse(old.endsAt) <= Date.parse(r.serverNow)
      )
        announce(old.id, old.endsAt, null, r.prefs.notify);
    }
  }, [announce]);

  useEffect(() => {
    void reload();
    return unlockAudioOnGesture();
  }, [reload]);

  // Every change, from any tab or device (state transitions only — never per second).
  useRealtimeRefresh(workspaceId, ["timers"], () => void reload());

  // The completion notice the server wrote (whoever settled the timer).
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`time:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const n = payload.new as {
            notification_type: string;
            title: string;
            metadata: { timerId?: string; at?: string; browser?: boolean } | null;
          };
          if (n.notification_type !== "time.completed" || !n.metadata?.timerId || !n.metadata.at)
            return;
          announce(n.metadata.timerId, n.metadata.at, n.title, Boolean(n.metadata.browser));
          void reload();
        },
      )
      .subscribe();
    return () => void supabase.removeChannel(channel);
  }, [userId, announce, reload]);

  // At the next end, ask the server to settle (a UI convenience; the background run and every
  // read settle too). A late timer (sleep, background tab) just fires late — the server already
  // knows the real end time.
  const s = useTime();
  useEffect(() => {
    const next = s.timers
      .filter((x) => x.state === "running" && x.endsAt)
      .map((x) => Date.parse(x.endsAt!) - timeStore.now().getTime())
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const id = window.setTimeout(
      () => void reload(),
      Math.max(250, Math.min(next + 400, 2 ** 31 - 1)),
    );
    return () => window.clearTimeout(id);
  }, [s.timers, reload]);

  return (
    <>
      <MiniTimer />
      <FocusOverlay />
    </>
  );
}

/** A tool result from the conversation: the new timer is on every view at once. */
export function receiveTimers(
  display: { kind: "timer"; timer: TimerPayload } | { kind: "timers"; timers: TimerPayload[] },
) {
  for (const t of display.kind === "timer" ? [display.timer] : display.timers) timeStore.upsert(t);
}
