import { formatDistanceToNow } from "date-fns";
import { enUS, es } from "date-fns/locale";
import { CloudOff, ExternalLink, RotateCw } from "lucide-react";
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { toast } from "sonner";

import { Orb } from "@/components/elise/orb/orb";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Switch } from "@/components/ui/switch";
import type {
  DesktopInfo,
  DesktopPreferences,
  DesktopUpdateState,
  HomeHubLocalState,
} from "@/core/platform/platform";
import { getDictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { useConnectivity, useSession } from "./data";
import { useDesktopRouter } from "./router";

const bridge = () => window.eliseDesktop!;
const fallbackT = () =>
  getDictionary(navigator.language.toLowerCase().startsWith("es") ? "es" : "en");

/** First run or signed out: sign in through the system browser (ADR-081). */
export function SignInScreen() {
  const t = fallbackT().desktop.signIn;
  const [waiting, setWaiting] = useState(false);
  const session = useSession();
  const pending = waiting && !session?.signedIn;
  return (
    <main className="elise-halo flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12 text-center">
      <Orb size={200} />
      <div className="flex max-w-sm flex-col items-center gap-3">
        <h1 className="text-[28px] leading-tight font-light tracking-[-0.025em]">{t.title}</h1>
        <p className="text-[14.5px] text-muted">{pending ? t.waiting : t.body}</p>
        <Button
          size="lg"
          className="mt-2"
          onClick={() => {
            setWaiting(true);
            void bridge().signIn();
          }}
        >
          {t.cta}
        </Button>
      </div>
    </main>
  );
}

/** Never one catastrophic page: a compact line, and the home still answers when it can. */
export function CloudBanner() {
  const c = useConnectivity();
  const { t } = useI18n();
  const s = t.desktop.status;
  const [retrying, setRetrying] = useState(false);
  const { refresh } = useDesktopRouter();
  if (c.cloud === "online") return null;
  return (
    <div
      role="status"
      className="mx-auto mt-2 flex w-[calc(100%-2*var(--page-gutter))] max-w-[960px] flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-surface px-3.5 py-2 text-[13px]"
    >
      <CloudOff className="size-4 shrink-0 text-muted" aria-hidden />
      <span>
        {c.internet === "offline" ? s.internetOffline : s.cloudOffline}{" "}
        <span className="text-muted">{s.cloudOfflineBody}</span>
      </span>
      {c.home === "online" && (
        <span className="text-muted">
          · {t.smartHome.title}: <span className="text-success">● {s.homeLocal}</span>
        </span>
      )}
      <button
        type="button"
        className="ml-auto inline-flex items-center gap-1.5 text-accent-text hover:underline disabled:opacity-60"
        disabled={retrying}
        onClick={async () => {
          setRetrying(true);
          refresh();
          setTimeout(() => setRetrying(false), 1500);
        }}
      >
        <RotateCw className={retrying ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
        {s.retry}
      </button>
    </div>
  );
}

const DISMISSED = "elise.update.dismissed";

/**
 * Updates (ADR-081): when a new version has downloaded in the background, a quiet bar offers
 * "Actualizar ahora" (ELISE restarts into it; ELISE Home stops cleanly first) or "Más tarde"
 * (until the next version). When ELISE Cloud stopped serving this Desktop's protocol, the bar
 * stays until it is updated.
 */
export function UpdateRequiredBanner() {
  const { t } = useI18n();
  const [update, setUpdate] = useState<DesktopUpdateState | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISSED);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    void bridge().getUpdateState().then(setUpdate);
    return bridge().onUpdate(setUpdate);
  }, []);
  const version = update?.status === "ready" ? (update.version ?? "") : "";
  const offered = update?.status === "ready" && !update.required && dismissed !== version;
  if (offered)
    return (
      <div
        role="status"
        className="mx-auto mt-2 flex w-[calc(100%-2*var(--page-gutter))] max-w-[960px] flex-wrap items-center gap-3 rounded-xl border border-accent-line bg-accent-soft px-3.5 py-2 text-[13px]"
      >
        <span className="min-w-0 flex-1">
          {installing ? t.desktop.updating : t.desktop.updateReady(version)}
        </span>
        {!installing && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                try {
                  localStorage.setItem(DISMISSED, version);
                } catch {
                  // Storage blocked: dismissed for this session only.
                }
                setDismissed(version);
              }}
            >
              {t.desktop.updateLater}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setInstalling(true);
                void bridge().installUpdate();
              }}
            >
              {t.desktop.updateNow}
            </Button>
          </>
        )}
      </div>
    );
  if (!update?.required) return null;
  return (
    <div
      role="alert"
      className="mx-auto mt-2 flex w-[calc(100%-2*var(--page-gutter))] max-w-[960px] items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-2 text-[13px]"
    >
      <span className="flex-1">{t.desktop.updateRequired}</span>
      <Button
        size="sm"
        onClick={() =>
          void (update.status === "ready" ? bridge().installUpdate() : bridge().checkForUpdates())
        }
      >
        {t.desktop.update}
      </Button>
    </div>
  );
}

/** "Última actualización: hace 2 h" — cached data is never presented as current. */
export function StaleNote({ cachedAt }: { cachedAt: string | null }) {
  const { t, locale } = useI18n();
  if (!cachedAt) return null;
  const when = formatDistanceToNow(new Date(cachedAt), {
    addSuffix: true,
    locale: locale === "es" ? es : enUS,
  });
  return (
    <p className="mx-auto mt-2 w-full max-w-[960px] px-[var(--page-gutter)] text-[12.5px] text-faint">
      {t.desktop.status.lastUpdated(when)}
    </p>
  );
}

export function Notice({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <PageContainer>
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-[20px] font-light tracking-[-0.02em]">{title}</h1>
        {body && <p className="text-[14px] text-muted">{body}</p>}
        {action}
      </div>
    </PageContainer>
  );
}

export function OpenInBrowser({ path }: { path: string }) {
  const { t } = useI18n();
  return (
    <Button
      variant="secondary"
      onClick={() => void bridge().openExternal(`${__ELISE_BUILD__.cloudUrl}${path}`)}
    >
      <ExternalLink />
      {t.desktop.openInBrowser}
    </Button>
  );
}

/** Sections not in the Desktop renderer yet open on the web — said plainly, never a blank page. */
export function NotYet({ path }: { path: string }) {
  const { t } = useI18n();
  return <Notice title={t.desktop.notYet} action={<OpenInBrowser path={path} />} />;
}

export function NeedsConnection({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <Notice
      title={t.desktop.needsConnection}
      body={t.desktop.status.cloudOfflineBody}
      action={
        <Button variant="secondary" onClick={onRetry}>
          <RotateCw />
          {t.desktop.status.retry}
        </Button>
      }
    />
  );
}

/** A screen failing never leaves a white window (ADR-081). */
export class RecoveryBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("renderer_error", error.message, info.componentStack?.slice(0, 400));
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: false });
  }
  render() {
    if (!this.state.error) return this.props.children;
    const t = fallbackT().desktop.recovery;
    return (
      <div
        role="alert"
        className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-16 text-center"
      >
        <h1 className="text-[20px] font-light tracking-[-0.02em]">{t.title}</h1>
        <p className="text-[14px] text-muted">{t.body}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => this.setState({ error: false })}>{t.retry}</Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            {t.restart}
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              await navigator.clipboard.writeText(await bridge().collectDiagnostics());
              toast.success(t.copied);
            }}
          >
            {t.diagnostics}
          </Button>
        </div>
      </div>
    );
  }
}

/** Settings › ELISE Desktop: device preferences, home, updates, version (ADR-081). */
export function DesktopSettings() {
  const { t } = useI18n();
  const s = t.desktop.settings;
  const confirm = useConfirm();
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [prefs, setPrefs] = useState<DesktopPreferences | null>(null);
  const [update, setUpdate] = useState<DesktopUpdateState>({ status: "idle" });
  const [home, setHome] = useState<HomeHubLocalState | null>(null);
  const c = useConnectivity();

  useEffect(() => {
    void bridge().getDesktopInfo().then(setInfo);
    void bridge().getPreferences().then(setPrefs);
    void bridge().getUpdateState().then(setUpdate);
    void bridge().getHomeHubState().then(setHome);
    return bridge().onHomeHub(setHome);
  }, [c]);

  const toggle = (key: keyof DesktopPreferences) => async (value: boolean) =>
    setPrefs(await bridge().setPreferences({ [key]: value }));

  const row =
    "flex items-center justify-between gap-4 border-b border-border py-3.5 last:border-b-0";
  return (
    <PageContainer>
      <PageHeader title={s.title} subtitle={s.description} />
      <section className="rounded-2xl border border-border bg-surface px-4">
        {prefs && (
          <>
            <label className={row}>
              <span className="text-[14px]">{s.startAtLogin}</span>
              <Switch
                checked={prefs.startAtLogin}
                onCheckedChange={toggle("startAtLogin")}
                aria-label={s.startAtLogin}
              />
            </label>
            <label className={row}>
              <span className="flex flex-col">
                <span className="text-[14px]">{s.keepInBackground}</span>
                <span className="text-[12.5px] text-muted">{s.keepInBackgroundHint}</span>
              </span>
              <Switch
                checked={prefs.keepInBackground}
                onCheckedChange={toggle("keepInBackground")}
                aria-label={s.keepInBackground}
              />
            </label>
            <label className={row}>
              <span className="text-[14px]">{s.notifications}</span>
              <Switch
                checked={prefs.notifications}
                onCheckedChange={toggle("notifications")}
                aria-label={s.notifications}
              />
            </label>
          </>
        )}
        <div className={row}>
          <span className="text-[14px]">{s.home}</span>
          <span className="text-[13.5px] text-muted">
            {home ? s.homeStates[home.runtime.enabled ? home.runtime.phase : "not_installed"] : "—"}
          </span>
        </div>
        {home?.runtime.version && (
          <details className="group py-3.5 text-[13px] text-muted">
            <summary className="cursor-pointer select-none">{s.advanced}</summary>
            <div className="mt-3 flex flex-col items-start gap-2">
              <p className="text-faint">{s.homeVersion(home.runtime.version)}</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const r = t.smartHome.runtime;
                  if (
                    await confirm({
                      title: r.remove,
                      body: r.removeBody,
                      confirmLabel: r.remove,
                      destructive: true,
                    })
                  )
                    await bridge().resetHome();
                }}
              >
                {t.smartHome.runtime.remove}
              </Button>
            </div>
          </details>
        )}
        <div className={row}>
          <span className="flex flex-col">
            <span className="text-[14px]">{s.updates}</span>
            <span className="text-[12.5px] text-muted">{s.updateStates[update.status]}</span>
          </span>
          {update.status === "ready" ? (
            <Button size="sm" onClick={() => void bridge().installUpdate()}>
              {s.installUpdate}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={update.status === "unsupported" || update.status === "checking"}
              onClick={async () => {
                await bridge().checkForUpdates();
                setUpdate(await bridge().getUpdateState());
              }}
            >
              {s.checkUpdates}
            </Button>
          )}
        </div>
        <div className={row}>
          <span className="text-[13.5px] text-muted">
            {info ? s.version(info.desktopVersion) : "—"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await navigator.clipboard.writeText(await bridge().collectDiagnostics());
              toast.success(t.desktop.recovery.copied);
            }}
          >
            {s.diagnostics}
          </Button>
        </div>
      </section>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <OpenInBrowser path="/settings" />
        <Button
          variant="ghost"
          onClick={async () => {
            if (
              await confirm({
                title: s.signOut,
                body: s.signOutConfirm,
                confirmLabel: s.signOut,
                destructive: true,
              })
            )
              await bridge().signOut();
          }}
        >
          {s.signOut}
        </Button>
      </div>
    </PageContainer>
  );
}
