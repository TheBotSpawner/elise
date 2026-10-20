"use client";

import {
  AirVent,
  Check,
  ChevronDown,
  Download,
  Lightbulb,
  Loader2,
  Monitor,
  RotateCw,
  Tv,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { relativeWhen } from "@/core/history/links";
import type { HomeSetupState, HomeSnapshot } from "@/core/home/model";
import {
  HOME_RUNTIME_BUSY,
  progressPercent,
  type HomeRuntimePhase,
  type HomeRuntimeStatus,
} from "@/core/home/runtime";
import { homeOnboarding, type DesktopPresence } from "@/core/platform/presence";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { useFeature } from "@/lib/platform/platform";
import { cn } from "@/lib/utils";

import { createPairingCodeAction } from "./actions";
import { DeviceDiscovery, useDevicesStepDone } from "./device-discovery";
import { useHomeRuntime } from "./runtime-context";

export interface DesktopDownload {
  platform: "windows" | "macos";
  arch: string;
  version: string;
  url: string;
  sizeBytes: number | null;
  beta: boolean;
}

const CARD = "rounded-3xl border border-border bg-surface";
const OPEN_DESKTOP = "elise://home/setup";

/** "Now", ticking: presence ages without a reload. */
function useNow(everyMs = 15_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function stepOf(state: HomeSetupState, hasHub: boolean): number {
  if (state === "hub_ready") return 2;
  if (state === "desktop_online" || state === "hub_initializing" || state === "hub_error") return 1;
  // A hub that went offline already passed step one.
  return hasHub && state === "desktop_offline" ? 1 : 0;
}

/**
 * Hogar's first run (ADR-079/080/082): from "I have nothing" to devices, advancing by itself from
 * authenticated presence — the browser never guesses what's installed. In ELISE Desktop the
 * same screen sets up this computer's Home Hub instead of offering a download.
 */
export function HomeSetup({
  snapshot,
  desktops,
  download,
  platform,
  devTools,
  timezone,
}: {
  snapshot: HomeSnapshot;
  desktops: readonly DesktopPresence[];
  download: DesktopDownload | null;
  platform: "windows" | "macos" | null;
  devTools: boolean;
  timezone: string;
}) {
  const router = useRouter();
  const now = useNow();
  const onDesktop = useFeature({ capability: "home_hub" }) === "supported";
  const runtime = useHomeRuntime();
  const ob = homeOnboarding(snapshot.hub?.setup ?? null, desktops, now);
  const runtimeStatus = runtime?.state?.runtime ?? null;
  const localPending = onDesktop && runtimeStatus && runtimeStatus.phase !== "ready";
  const step = localPending
    ? runtimeStatus.enabled
      ? 1
      : 0
    : stepOf(ob.state, Boolean(snapshot.hub));

  // Realtime moves this screen; a quiet refresh covers presence going stale and missed events.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 15_000);
    return () => clearInterval(timer);
  }, [router]);

  let content: ReactNode;
  if (onDesktop && runtime && localPending)
    content = <RuntimeCard runtime={runtime} status={runtimeStatus} />;
  else if (ob.state === "desktop_not_configured" && !onDesktop)
    content = <WebStart download={download} platform={platform} />;
  else content = <Progress snapshot={snapshot} ob={ob} timezone={timezone} onDesktop={onDesktop} />;

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-6 pt-1 md:gap-8 md:pt-4">
      <Stepper step={step} />
      <section
        className={cn(CARD, "grid overflow-hidden lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]")}
      >
        <div
          className="flex flex-col gap-5 px-5 py-7 sm:px-8 sm:py-9 lg:px-10 lg:py-11"
          aria-live="polite"
        >
          {content}
        </div>
        <div className="relative hidden items-center justify-center border-l border-border bg-surface-2/40 p-8 lg:flex">
          <HomeVisual active={step} />
        </div>
      </section>
      {devTools && <DevPairing />}
    </div>
  );
}

// ── Stepper ──────────────────────────────────────────────────────────────────

function Stepper({ step }: { step: number }) {
  const { t } = useI18n();
  const s = t.smartHome.setup;
  const total = s.steps.length;
  return (
    <nav aria-label={s.progressLabel}>
      {/* Phones: one line and a bar. */}
      <div className="flex flex-col gap-2 lg:hidden">
        <p className="text-[13px] text-muted">
          {s.stepOf(step + 1, total)} · <span className="font-medium text-fg">{s.steps[step]}</span>
        </p>
        <div
          className="h-1 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={step + 1}
          aria-valuetext={`${s.stepOf(step + 1, total)}: ${s.steps[step]}`}
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${((step + 1) / total) * 100}%` }}
          />
        </div>
      </div>
      <ol className="hidden items-center lg:flex">
        {s.steps.map((label, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <li
              key={label}
              aria-current={active ? "step" : undefined}
              className="flex flex-1 items-center gap-2.5 last:flex-none"
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full border text-[13px] font-medium transition-colors",
                  done && "border-transparent bg-accent text-accent-fg",
                  active && "border-accent bg-accent-soft text-fg ring-4 ring-accent/15",
                  !done && !active && "border-border text-faint",
                )}
              >
                {done ? <Check className="size-4" aria-hidden /> : i + 1}
              </span>
              <span
                className={cn(
                  "text-[13.5px] whitespace-nowrap",
                  active ? "font-medium text-fg" : done ? "text-muted" : "text-faint",
                )}
              >
                {label}
                <span className="sr-only">
                  {done ? ` — ${s.stepDone}` : active ? ` — ${s.stepCurrent}` : ""}
                </span>
              </span>
              {i < total - 1 && (
                <span
                  aria-hidden
                  className={cn("mx-3 h-px min-w-6 flex-1", done ? "bg-accent" : "bg-border")}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ── Visual ───────────────────────────────────────────────────────────────────

/** ELISE at the center, the home around it: quiet, token-colored, decorative only. */
function HomeVisual({ active }: { active: number }) {
  // Centers, in the same 0–300 space as the lines.
  const devices = [
    { Icon: Lightbulb, x: 52, y: 58 },
    { Icon: AirVent, x: 252, y: 92 },
    { Icon: Tv, x: 150, y: 262 },
  ];
  const lit = active >= 2;
  return (
    <div aria-hidden className="relative aspect-square w-full max-w-[320px]">
      <svg viewBox="0 0 300 300" className="absolute inset-0 size-full">
        {devices.map(({ x, y }) => (
          <line
            key={`${x}-${y}`}
            x1={150}
            y1={150}
            x2={x}
            y2={y}
            strokeWidth={1}
            strokeDasharray={lit ? undefined : "3 5"}
            className={lit ? "stroke-accent/60" : "stroke-border-strong"}
          />
        ))}
      </svg>
      <div className="absolute top-1/2 left-1/2 size-[30%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent-line bg-accent-soft shadow-[0_0_70px_-12px_var(--accent)]">
        <div className="absolute inset-[18%] rounded-full border border-accent-line motion-safe:animate-[pulse_4s_ease-in-out_infinite]" />
        <div className="absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_14px_var(--accent)]" />
      </div>
      {devices.map(({ Icon, x, y }, i) => (
        <span
          key={i}
          className={cn(
            "absolute flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border bg-surface shadow-sm",
            lit ? "border-accent-line text-accent-text" : "border-border text-muted",
          )}
          style={{ left: `${(x / 300) * 100}%`, top: `${(y / 300) * 100}%` }}
        >
          <Icon className="size-6" strokeWidth={1.5} />
        </span>
      ))}
    </div>
  );
}

// ── Web: start ───────────────────────────────────────────────────────────────

type StartMode = "idle" | "installing" | "looking" | "not_opened";

function useOpenDesktop(onTimeout: () => void) {
  return () => {
    // A convenience only: Desktop's authenticated heartbeat is what advances setup.
    window.location.href = OPEN_DESKTOP;
    window.setTimeout(onTimeout, 15_000);
  };
}

function WebStart({
  download,
  platform,
}: {
  download: DesktopDownload | null;
  platform: "windows" | "macos" | null;
}) {
  const { t } = useI18n();
  const s = t.smartHome.setup;
  const d = t.download;
  const [mode, setMode] = useState<StartMode>("idle");
  const open = useOpenDesktop(() => setMode((m) => (m === "looking" ? "not_opened" : m)));
  const look = () => {
    setMode("looking");
    open();
  };
  const downloadButton = download ? (
    <a
      href={download.url}
      download
      onClick={() => setMode("installing")}
      className={cn(buttonVariants({ size: "lg" }), "max-sm:w-full")}
    >
      <Download aria-hidden />
      {s.downloadFor(d.platforms[download.platform])}
    </a>
  ) : (
    <Link
      href="/download/desktop?from=home"
      className={cn(buttonVariants({ size: "lg" }), "max-sm:w-full")}
    >
      <Download aria-hidden />
      {s.download}
    </Link>
  );

  if (mode === "installing")
    return (
      <>
        <Heading>{s.installingTitle}</Heading>
        <p className="max-w-xl text-[15px] text-muted">{s.installingBody}</p>
        <Waiting label={s.waiting} />
        <div className="flex flex-wrap gap-2 max-sm:flex-col">
          <Button onClick={look}>{s.installedIt}</Button>
          {download && (
            <a href={download.url} download className={buttonVariants({ variant: "ghost" })}>
              {s.download}
            </a>
          )}
        </div>
      </>
    );

  if (mode === "looking" || mode === "not_opened")
    return (
      <>
        <Heading>{mode === "looking" ? s.looking : s.notOpened}</Heading>
        {mode === "looking" ? (
          <>
            <p className="max-w-xl text-[15px] text-muted">{s.lookingBody}</p>
            <Waiting label={s.looking} />
          </>
        ) : (
          <div className="flex flex-wrap gap-2 max-sm:flex-col">
            <Button onClick={look}>
              <RotateCw aria-hidden />
              {s.openAgain}
            </Button>
            {downloadButton}
          </div>
        )}
      </>
    );

  return (
    <>
      <div className="flex flex-col gap-3">
        <Heading large>{s.heroTitle}</Heading>
        <p className="max-w-xl text-[16px] leading-relaxed text-muted">{s.heroBody}</p>
        <p className="max-w-xl text-[14px] text-faint">{s.heroSupport}</p>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch">
          {downloadButton}
          <Button variant="secondary" size="lg" onClick={look} className="max-sm:w-full">
            {s.haveIt}
          </Button>
        </div>
        {download ? (
          <p className="text-[12.5px] text-faint">
            {s.downloadMeta(d.platforms[download.platform], download.arch, download.version)}
            {download.beta && (
              <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">
                {s.beta}
              </span>
            )}
          </p>
        ) : (
          platform && <p className="text-[12.5px] text-faint">{s.unavailable}</p>
        )}
      </div>
      <ul className="flex flex-col gap-2.5 border-t border-border pt-5 sm:flex-row sm:flex-wrap sm:gap-x-6">
        {s.benefits.map((b) => (
          <li key={b} className="flex items-center gap-2 text-[14px] text-muted">
            <Check className="size-4 shrink-0 text-success" aria-hidden />
            {b}
          </li>
        ))}
      </ul>
    </>
  );
}

// ── Web/Desktop: presence-driven progress ───────────────────────────────────

function Progress({
  snapshot,
  ob,
  timezone,
  onDesktop,
}: {
  snapshot: HomeSnapshot;
  ob: ReturnType<typeof homeOnboarding>;
  timezone: string;
  onDesktop: boolean;
}) {
  const { t, locale } = useI18n();
  const [, markDevicesDone] = useDevicesStepDone();
  const s = t.smartHome.setup;
  const [mode, setMode] = useState<"idle" | "looking" | "not_opened">("idle");
  const open = useOpenDesktop(() => setMode((m) => (m === "looking" ? "not_opened" : m)));
  const openButton = onDesktop ? null : (
    <div className="flex flex-col items-start gap-2">
      <Button
        onClick={() => {
          setMode("looking");
          open();
        }}
      >
        {mode === "not_opened" ? s.openAgain : s.openDesktop}
      </Button>
      {mode === "not_opened" && (
        <p className="text-[13px] text-muted">
          {s.notOpened}{" "}
          <Link href="/download/desktop?from=home" className="text-accent-text hover:underline">
            {s.download}
          </Link>
        </p>
      )}
    </div>
  );
  const lastSeen = snapshot.hub?.lastSeenAt
    ? s.lastSeen(relativeWhen(snapshot.hub.lastSeenAt, new Date(), locale, timezone))
    : null;

  switch (ob.state) {
    case "desktop_offline":
      return (
        <>
          <Heading>{s.offlineTitle}</Heading>
          <p className="max-w-xl text-[15px] text-muted">
            {[s.offlineBody, lastSeen].filter(Boolean).join(" ")}
          </p>
          {openButton}
        </>
      );
    case "desktop_update_required":
      return (
        <>
          <Heading>{s.updateTitle}</Heading>
          <p className="max-w-xl text-[15px] text-muted">{s.updateBody}</p>
          {openButton}
        </>
      );
    case "hub_initializing":
      return (
        <>
          <Done label={s.connected} />
          <Heading>{s.initializingTitle}</Heading>
          <p className="max-w-xl text-[15px] text-muted">{s.initializingBody}</p>
          <Bar percent={null} label={s.initializingTitle} />
        </>
      );
    case "hub_error":
      return (
        <>
          <Heading>{s.errorTitle}</Heading>
          <p className="max-w-xl text-[15px] text-muted">{s.errorBody}</p>
          {openButton}
        </>
      );
    case "hub_ready":
      // ADR-090: the engine doesn't add what it finds by itself; the person chooses.
      return (
        <>
          <Done label={s.hubReady} />
          <Heading>{s.discover.title}</Heading>
          <DeviceDiscovery
            onDone={markDevicesDone}
            addedCount={snapshot.devices.length}
            found={snapshot.found}
          />
        </>
      );
    default:
      break;
  }

  // desktop_online (or nothing yet, inside Desktop): which computer, and how far it got.
  if (ob.choose)
    return (
      <>
        <Done label={s.connected} />
        <Heading>{s.chooseTitle}</Heading>
        <p className="max-w-xl text-[15px] text-muted">{s.chooseBody}</p>
        <ul className="flex flex-col gap-2">
          {ob.online.map((d) => (
            <li
              key={d.installationId}
              className="flex items-center gap-3 rounded-2xl border border-border px-4 py-3"
            >
              <Monitor className="size-5 text-muted" aria-hidden />
              <span className="flex-1 text-[14.5px]">{d.name}</span>
              <span className="text-[12.5px] text-success">● {s.online}</span>
            </li>
          ))}
        </ul>
        {openButton}
      </>
    );

  const host = ob.host;
  const phase: HomeRuntimePhase | null = host?.homeEnabled ? host.homeRuntimePhase : null;
  const name = host?.name ?? "ELISE Desktop";
  return (
    <>
      {host && <Done label={`${s.connected} · ${host.name}`} />}
      {phase && HOME_RUNTIME_BUSY.has(phase) ? (
        <>
          <Heading>{s.preparingOn(name)}</Heading>
          <Bar percent={host?.homeRuntimeProgress ?? null} label={s.preparingOn(name)} />
        </>
      ) : phase && ["requirements_missing", "restart_required", "error"].includes(phase) ? (
        <>
          <Heading>{s.needsYouOn(name)}</Heading>
          {openButton}
        </>
      ) : phase === "ready" ? (
        <>
          <Heading>{s.initializingTitle}</Heading>
          <Bar percent={null} label={s.initializingTitle} />
        </>
      ) : (
        <>
          <Heading>{s.prepareTitle}</Heading>
          <p className="max-w-xl text-[15px] text-muted">{s.prepareBody(name)}</p>
          {openButton}
        </>
      )}
    </>
  );
}

// ── Desktop: this computer's Home Hub ───────────────────────────────────────

function RuntimeCard({
  runtime,
  status,
}: {
  runtime: NonNullable<ReturnType<typeof useHomeRuntime>>;
  status: HomeRuntimeStatus;
}) {
  const { t } = useI18n();
  const r = t.smartHome.runtime;
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [later, setLater] = useState(false);
  const act = (fn: () => Promise<void>) =>
    start(async () => {
      try {
        await fn();
      } catch {
        toast.error(r.errors.HOME_RUNTIME_INSTALL_FAILED);
      }
    });
  const copy = async () => {
    await navigator.clipboard.writeText(await runtime.diagnostics());
    toast.success(r.copied);
  };
  const details = (
    <details className="group text-[13px] text-muted">
      <summary className="flex cursor-pointer list-none items-center gap-1 select-none">
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
        {r.details}
      </summary>
      <ul className="mt-3 flex flex-col gap-1.5">
        {(status.requirements ?? []).map((q) => (
          <li key={q.key} className="flex items-start gap-2">
            <span aria-hidden className={q.ok ? "text-success" : "text-danger-text"}>
              {q.ok ? "✓" : "✗"}
            </span>
            <span>
              {r.requirements[q.key]}
              {q.detail && <span className="text-faint"> · {q.detail}</span>}
            </span>
          </li>
        ))}
        {status.error?.detail && (
          <li className="font-mono text-[12px] text-faint">{status.error.detail}</li>
        )}
      </ul>
      <button type="button" onClick={copy} className="mt-3 text-accent-text hover:underline">
        {r.copyDiagnostics}
      </button>
    </details>
  );

  if (HOME_RUNTIME_BUSY.has(status.phase)) {
    const stage = status.progress?.stage;
    const label = stage ? r.stages[stage] : r.stages.checking;
    return (
      <>
        <Heading>{r.preparing}</Heading>
        <p className="text-[15px] text-muted">{label}</p>
        <Bar percent={progressPercent(status.progress)} label={label} />
        <p className="text-[13px] text-faint">{r.note}</p>
      </>
    );
  }

  if (status.phase === "restart_required")
    return (
      <>
        <Heading>{r.restartTitle}</Heading>
        <p className="max-w-xl text-[15px] text-muted">{later ? r.laterBody : r.restartBody}</p>
        {!later && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => act(runtime.restartComputer)} disabled={pending}>
              {r.restartNow}
            </Button>
            <Button variant="secondary" onClick={() => setLater(true)}>
              {r.later}
            </Button>
          </div>
        )}
      </>
    );

  if (
    status.phase === "requirements_missing" &&
    status.error?.code === "HOME_RUNTIME_REQUIREMENT_MISSING"
  )
    return (
      <>
        <Heading>{r.needsFeatureTitle}</Heading>
        <p className="max-w-xl text-[15px] text-muted">{r.needsFeatureBody}</p>
        <div>
          <Button onClick={() => act(runtime.enableRequirements)} disabled={pending}>
            {r.configure}
          </Button>
        </div>
        {details}
      </>
    );

  if (
    status.phase === "requirements_missing" ||
    status.phase === "error" ||
    status.phase === "degraded"
  )
    return (
      <>
        <Heading>
          {status.error ? r.errors[status.error.code] : t.smartHome.setup.errorTitle}
        </Heading>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => act(runtime.setup)} disabled={pending}>
            <RotateCw aria-hidden />
            {r.retry}
          </Button>
          {status.version && (
            <Button
              variant="ghost"
              onClick={async () => {
                if (
                  await confirm({
                    title: r.remove,
                    body: r.removeBody,
                    confirmLabel: r.remove,
                    destructive: true,
                  })
                )
                  act(runtime.reset);
              }}
            >
              {r.remove}
            </Button>
          )}
        </div>
        {details}
      </>
    );

  // Not set up (or stopped): the invitation.
  return (
    <>
      <div className="flex flex-col gap-3">
        <Heading large>{r.title}</Heading>
        <p className="max-w-xl text-[16px] leading-relaxed text-muted">{r.body}</p>
      </div>
      <div>
        <Button size="lg" onClick={() => act(runtime.setup)} disabled={pending}>
          {r.cta}
        </Button>
      </div>
      <p className="text-[13px] text-faint">{r.note}</p>
    </>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Heading({ children, large }: { children: ReactNode; large?: boolean }) {
  return (
    <h2
      className={cn(
        "font-light tracking-[-0.02em] text-balance",
        large
          ? "text-[28px] leading-[1.15] sm:text-[34px]"
          : "text-[22px] leading-tight sm:text-[26px]",
      )}
    >
      {children}
    </h2>
  );
}

function Done({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-[13.5px] text-success">
      <Check className="size-4" aria-hidden />
      {label}
    </p>
  );
}

function Waiting({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-[14px] text-muted" role="status">
      <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
      {label}
    </p>
  );
}

/** Real progress when known; otherwise an honest "working" bar (no invented percentages). */
function Bar({ percent, label }: { percent: number | null; label: string }) {
  return (
    <div className="flex max-w-md items-center gap-3">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent !== null ? { "aria-valuenow": percent } : {})}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"
      >
        {percent !== null ? (
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="h-full w-1/3 rounded-full bg-accent motion-safe:animate-pulse" />
        )}
      </div>
      {percent !== null && <span className="text-[13px] text-muted tabular-nums">{percent}%</span>}
    </div>
  );
}

/** Development only (the CLI hub): never shown to people in production. */
function DevPairing() {
  const { t, locale } = useI18n();
  const s = t.smartHome.setup;
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <details className="text-[13px] text-faint">
      <summary className="cursor-pointer select-none">{s.devTitle}</summary>
      <div className="mt-2 flex flex-col items-start gap-2">
        <p>{s.devBody}</p>
        {code ? (
          <>
            <p className="font-mono text-[18px] tracking-[0.12em] text-fg">{code.code}</p>
            <p className="text-[12px]">
              {new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
                new Date(code.expiresAt),
              )}{" "}
              · {s.devCommand}
            </p>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await createPairingCodeAction();
                if (r.ok) setCode(r.value);
                else toast.error(errorText(t, r.error));
              })
            }
          >
            {s.devGenerate}
          </Button>
        )}
      </div>
    </details>
  );
}
