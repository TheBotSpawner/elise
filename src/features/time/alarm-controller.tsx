"use client";

import { AlarmClock, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { EliseDesktopBridge } from "@/core/platform/platform";
import { stillRinging, type AlarmOccurrence } from "@/core/timers/alarms";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";

import { ring, unlockAlarmAudio, type Ringing } from "./alarm-sound";
import {
  alarmOp,
  alarmsStore,
  browserEndpoint,
  loadAlarms,
  resolveMe,
  targets,
  useAlarms,
} from "./alarms-client";

/**
 * Rings alarms on this device (ADR-100), mounted on every page. It rings only what the server
 * says is ringing AND targets this device (the Desktop installation, or the browser the user
 * chose); it reports what really happened (received, playing, blocked, stopped). A snooze or
 * stop on any device stops it here too; a local failsafe stops it after ten minutes regardless.
 *
 * On ELISE Desktop the main process also keeps the next alarms itself, so they fire with the
 * cloud unreachable or after a restart; the two never ring twice (same alarm and time).
 */

type DesktopAlarms = Pick<EliseDesktopBridge, "alarmSchedule" | "onAlarmFire">;
const desktop = () => (window as { eliseDesktop?: DesktopAlarms }).eliseDesktop;

/** What rings here now: an occurrence from the server, or a local Desktop firing waiting for it. */
interface Active {
  key: string;
  occurrence: AlarmOccurrence | null;
  alarmId: string;
  fireAt: string;
  label: string | null;
  sound: string;
  handle: Ringing | null;
  playing: boolean;
}

const HEARTBEAT_MS = 60_000;
/**
 * Realtime can miss an event (a socket dropped, a laptop asleep, an app just started), and an
 * alarm must never depend on one: the alarms are read again this often, and on focus/online.
 */
const REFRESH_MS = 30_000;

export function AlarmController({ workspaceId }: { workspaceId: string }) {
  const s = useAlarms();
  const [active, setActive] = useState<Active | null>(null);
  const activeRef = useRef<Active | null>(null);
  useEffect(() => {
    activeRef.current = active;
  });

  const reload = useCallback(() => void loadAlarms(), []);
  useEffect(() => {
    void resolveMe().then((me) => alarmsStore.set({ me }));
    // The first read can fail while the app is still connecting (Desktop at startup): retry,
    // or this device would keep an empty list until something else changed.
    let tries = 0;
    let retry: number | undefined;
    const first = async () => {
      if (!(await loadAlarms()) && ++tries < 6) retry = window.setTimeout(first, 2_000 * tries);
    };
    void first();
    return () => window.clearTimeout(retry);
  }, []);
  useRealtimeRefresh(workspaceId, ["alarms", "alarm_occurrences"], reload);
  useEffect(() => {
    const t = window.setInterval(reload, REFRESH_MS);
    window.addEventListener("focus", reload);
    window.addEventListener("online", reload);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", reload);
      window.removeEventListener("online", reload);
    };
  }, [reload]);

  // A chosen browser says it's here while ELISE is open (Desktop has its own heartbeat).
  useEffect(() => {
    if (s.me?.kind !== "browser") return;
    const beat = () => {
      const id = browserEndpoint();
      if (id) void alarmOp({ op: "heartbeat", endpointId: id }).catch(() => undefined);
    };
    beat();
    const t = window.setInterval(beat, HEARTBEAT_MS);
    return () => window.clearInterval(t);
  }, [s.me]);

  const report = useCallback(
    (o: AlarmOccurrence | null, event: "received" | "playing" | "blocked" | "stopped") => {
      const me = alarmsStore.get().me;
      if (!o || !me) return;
      void alarmOp({ op: "receipt", id: o.id, device: `${me.kind}:${me.id}`, event }).catch(
        () => undefined,
      );
    },
    [],
  );

  const start = useCallback(
    async (a: Omit<Active, "handle" | "playing">) => {
      const volume = alarmsStore.get().prefs?.alarmVolume ?? 80;
      const handle = await ring(a.sound, volume, true);
      setActive({ ...a, handle, playing: handle.playing });
      report(a.occurrence, "received");
      report(a.occurrence, handle.playing ? "playing" : "blocked");
    },
    [report],
  );

  const stopLocal = useCallback(() => {
    activeRef.current?.handle?.stop();
    setActive(null);
  }, []);

  // The server's ringing occurrences for this device.
  useEffect(() => {
    const now = Date.now();
    const mine = s.live.find(
      (o) =>
        o.status === "ringing" &&
        o.ringingSince &&
        stillRinging(new Date(o.ringingSince), new Date(now)) &&
        targets(o, s.me),
    );
    const cur = activeRef.current;
    if (!mine) {
      // Stopped or snoozed elsewhere (or expired): stop here — unless a local Desktop firing
      // is still waiting for its occurrence to arrive.
      if (cur?.occurrence) {
        report(cur.occurrence, "stopped");
        stopLocal();
      }
      return;
    }
    const key = `${mine.alarmId}|${mine.fireAt}|${mine.ringingSince}`;
    if (cur && cur.alarmId === mine.alarmId && cur.fireAt === mine.fireAt) {
      // A local Desktop firing adopts its occurrence: one ring, never two — and says it rang.
      if (!cur.occurrence) {
        setActive({ ...cur, occurrence: mine, key });
        report(mine, "received");
        report(mine, cur.playing ? "playing" : "blocked");
      }
      if (cur.key === key || !cur.occurrence) return;
    }
    cur?.handle?.stop();
    void start({
      key,
      occurrence: mine,
      alarmId: mine.alarmId,
      fireAt: mine.fireAt,
      label: mine.label,
      sound: mine.sound ?? s.prefs?.alarmSound ?? "brisa",
    });
  }, [s.live, s.me, s.prefs, start, stopLocal, report]);

  // ELISE Desktop: keep the next alarms in the app itself, and ring what it fires locally.
  useEffect(() => {
    const d = desktop();
    if (!d?.alarmSchedule || s.me?.kind !== "desktop") return;
    const horizon = Date.now() + 48 * 3_600_000;
    void d
      .alarmSchedule(
        s.alarms
          .filter(
            (a) =>
              a.enabled && a.nextFireAt && Date.parse(a.nextFireAt) <= horizon && targets(a, s.me),
          )
          .map((a) => ({ alarmId: a.id, fireAt: a.nextFireAt!, label: a.label })),
      )
      .catch(() => undefined);
  }, [s.alarms, s.me]);
  useEffect(() => {
    const d = desktop();
    if (!d?.onAlarmFire) return;
    return d.onAlarmFire((e) => {
      const cur = activeRef.current;
      if (cur && cur.alarmId === e.alarmId && cur.fireAt === e.fireAt) return;
      const alarm = alarmsStore.get().alarms.find((a) => a.id === e.alarmId);
      void start({
        key: `${e.alarmId}|${e.fireAt}|local`,
        occurrence: null,
        alarmId: e.alarmId,
        fireAt: e.fireAt,
        label: e.label,
        sound: alarm?.sound ?? alarmsStore.get().prefs?.alarmSound ?? "brisa",
      });
      reload();
    });
  }, [start, reload]);

  const act = async (action: "snooze" | "dismiss") => {
    const cur = activeRef.current;
    stopLocal();
    let occ = cur?.occurrence;
    if (!occ && cur) {
      // A local firing whose occurrence hasn't arrived yet: find it now.
      await loadAlarms();
      occ =
        alarmsStore.get().live.find((o) => o.alarmId === cur.alarmId && o.fireAt === cur.fireAt) ??
        null;
    }
    if (occ) {
      report(occ, "stopped");
      await alarmOp({ op: "occurrence", id: occ.id, action }).catch(() => undefined);
    }
    reload();
  };

  if (!active) return null;
  return (
    <AlarmBanner
      label={active.label}
      fireAt={active.fireAt}
      timezone={s.timezone}
      playing={active.playing}
      snoozeMinutes={s.alarms.find((a) => a.id === active.alarmId)?.snoozeMinutes ?? 9}
      onSnooze={() => void act("snooze")}
      onDismiss={() => void act("dismiss")}
      onEnableSound={async () => {
        await unlockAlarmAudio();
        const cur = activeRef.current;
        if (!cur) return;
        cur.handle?.stop();
        await start({ ...cur });
      }}
    />
  );
}

function AlarmBanner(p: {
  label: string | null;
  fireAt: string;
  timezone: string;
  playing: boolean;
  snoozeMinutes: number;
  onSnooze: () => void;
  onDismiss: () => void;
  onEnableSound: () => void;
}) {
  const { t, locale } = useI18n();
  const a = t.time.alarms;
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: p.timezone,
  }).format(new Date(p.fireAt));
  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label={a.ringing}
      className="fixed top-4 left-1/2 z-[70] flex w-[min(440px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-3 rounded-2xl border border-accent-line bg-[var(--menu-bg)] p-4 shadow-2xl backdrop-blur"
    >
      <div className="flex items-center gap-3">
        <AlarmClock className="size-6 shrink-0 animate-pulse text-accent-text" aria-hidden />
        <div className="min-w-0">
          <p className="font-mono text-2xl leading-none">{time}</p>
          <p className="truncate text-[14px] text-muted">{p.label ?? a.ringing}</p>
        </div>
      </div>
      {!p.playing && (
        <button
          type="button"
          onClick={p.onEnableSound}
          className="inline-flex items-center gap-2 self-start rounded-full border border-approval-text/40 px-3 py-1.5 text-[13px] text-approval-text"
        >
          <Volume2 className="size-4" aria-hidden />
          {a.tapForSound}
        </button>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={p.onSnooze}
          className="h-11 flex-1 rounded-full border border-border text-[14px] hover:border-accent-line"
        >
          {a.snooze(p.snoozeMinutes)}
        </button>
        <button
          type="button"
          onClick={p.onDismiss}
          autoFocus
          className="h-11 flex-1 rounded-full bg-fg text-[14px] font-medium text-bg"
        >
          {a.dismiss}
        </button>
      </div>
    </div>
  );
}
