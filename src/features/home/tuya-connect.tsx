"use client";

import { Check, Cloud, Fan, Loader2, RotateCw, Snowflake, Trash2, Tv } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import type {
  TuyaAvailability,
  TuyaConnectionView as TuyaConnection,
} from "@/application/tuya-connection-service";
import type { TuyaHubView, TuyaRemoteView } from "@/application/tuya-home-service";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import type { TuyaRegion, tuyaTestAction } from "@/core/home/tuya";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  connectTuyaAction,
  controlDeviceAction,
  disconnectTuyaAction,
  linkTuyaTestAction,
  tuyaImportAction,
  tuyaOverviewAction,
  tuyaStatusAction,
  tuyaSyncAction,
} from "./actions";

type Test = NonNullable<ReturnType<typeof tuyaTestAction>>;
type Added = { id: string; name: string; infraredId: string; remoteId: string; test: Test | null };

const KIND_ICON = { tv: Tv, ac: Snowflake, fan: Fan, other: Cloud } as const;
const keyOf = (r: Pick<TuyaRemoteView, "infraredId" | "remoteId">) =>
  `${r.infraredId}:${r.remoteId}`;

/**
 * ADR-119/128: Smart Life in Agregar dispositivos, as a service row whose state is what the
 * server can really do. With no account: "Conectar" opens Tuya's official authorization when
 * it's configured, or links the owner's account in its one workspace (the server enforces that;
 * the screen just shows a normal Conectar); otherwise "Todavía no disponible", disabled. With
 * accounts: each one lists its hubs → the remotes already set up in Smart Life, ready to add
 * (no learning). "Probar" sends one safe key only after confirmation.
 */
export function TuyaConnect() {
  const { t } = useI18n();
  const x = t.smartHome.setup.discover.tuya;
  const params = useSearchParams();
  const [status, setStatus] = useState<{
    availability: TuyaAvailability;
    testLink: boolean;
    connections: TuyaConnection[];
  } | null>(null);
  const [region, setRegion] = useState<TuyaRegion | "">("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await tuyaStatusAction();
    if (r.ok) setStatus(r.value);
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    // Desktop: the authorization finishes in the system browser; back in ELISE, look again.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  if (!status || status.availability.state === "off") return null;
  const { availability, connections, testLink } = status;
  const linkTest = async () => {
    setLinking(true);
    setLinkError(null);
    const r = await linkTuyaTestAction();
    setLinking(false);
    if (!r.ok) setLinkError(errorText(t, r.error));
    await load();
  };
  const failed = params.get("tuya_error");
  const regions = availability.state === "available" ? availability.regions : [];
  const chosen = region || (regions.length === 1 ? regions[0]! : "");
  const notice = (
    <>
      {failed && (
        <p role="alert" className="text-[13px] text-danger-text">
          {x.problems[failed as keyof typeof x.problems] ?? x.problems.generic}
        </p>
      )}
      {linkError && (
        <p role="alert" className="text-[13px] text-danger-text">
          {linkError}
        </p>
      )}
    </>
  );

  if (connections.length)
    return (
      <div className="flex flex-col gap-2">
        {connections.map((c) => (
          <ConnectionCard
            key={c.id}
            connection={c}
            showRegion={connections.length > 1}
            onChanged={load}
          />
        ))}
        {notice}
      </div>
    );

  const offered = availability.state === "available";
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-border bg-surface px-3.5 py-3">
      <ServiceHeader
        title={x.title}
        status={offered || testLink ? x.hint : x.notYetShort}
        actions={
          offered ? null : (
            <Button
              size="sm"
              variant="secondary"
              disabled={!testLink || linking}
              onClick={() => void linkTest()}
            >
              {linking && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
              {x.connect}
            </Button>
          )
        }
      />
      {offered && (
        <form action={connectTuyaAction} className="flex flex-wrap items-center gap-2">
          <Select
            name="region"
            required
            aria-label={x.region}
            value={chosen}
            onChange={(e) => setRegion(e.target.value as TuyaRegion)}
            className="h-10 min-w-0 flex-1"
          >
            <option value="" disabled>
              {x.region}
            </option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {x.regions[r]}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm" disabled={!chosen}>
            {x.connect}
          </Button>
        </form>
      )}
      {notice}
    </div>
  );
}

/** Icon, name and one status line; actions to the right, or below when the row is narrow. */
function ServiceHeader({
  title,
  status,
  warn = false,
  actions,
}: {
  title: string;
  status: string;
  warn?: boolean;
  actions: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
        <Cloud className="size-4.5" aria-hidden />
      </span>
      <span className="flex min-w-[8rem] flex-1 flex-col">
        <span className="truncate text-[14.5px]">{title}</span>
        <span
          className={cn("truncate text-[12.5px]", warn ? "text-approval-text" : "text-muted")}
          title={status}
        >
          {status}
        </span>
      </span>
      {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
    </div>
  );
}

/** A small icon-only action, named for screen readers and on hover. */
function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="w-8 px-0"
    >
      {children}
    </Button>
  );
}

function ConnectionCard({
  connection: c,
  showRegion,
  onChanged,
}: {
  connection: TuyaConnection;
  showRegion: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const x = t.smartHome.setup.discover.tuya;
  const router = useRouter();
  const [hubs, setHubs] = useState<TuyaHubView[] | null>(null);
  const [busy, setBusy] = useState<"load" | "sync" | "import" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, Added>>({});
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const needsReconnect = c.status === "needs_reauthorization";

  const open = useCallback(async () => {
    setBusy("load");
    setError(null);
    const r = await tuyaOverviewAction(c.id);
    setBusy(null);
    if (!r.ok) {
      setError(errorText(t, r.error));
      return void onChanged();
    }
    setHubs(r.value.hubs);
  }, [c.id, onChanged, t]);

  // A connected account shows its remotes right away: nothing to open first.
  useEffect(() => {
    if (needsReconnect) return;
    const first = setTimeout(() => void open(), 0);
    return () => clearTimeout(first);
  }, [needsReconnect, open]);

  const importRemotes = async (remotes: TuyaRemoteView[], replaces?: string) => {
    setBusy("import");
    setError(null);
    const r = await tuyaImportAction({
      connectionId: c.id,
      remotes: remotes.map((m) => ({
        infraredId: m.infraredId,
        remoteId: m.remoteId,
        ...(replaces ? { replaces } : {}),
      })),
    });
    setBusy(null);
    if (!r.ok) return setError(errorText(t, r.error));
    setAdded((m) => ({ ...m, ...Object.fromEntries(r.value.added.map((a) => [keyOf(a), a])) }));
    if (r.value.skipped.length) setError(x.skipped(r.value.skipped.length));
    router.refresh();
  };

  const sync = async () => {
    setBusy("sync");
    setError(null);
    const r = await tuyaSyncAction(c.id);
    setBusy(null);
    if (!r.ok) setError(errorText(t, r.error));
    else router.refresh();
    await open();
  };

  const disconnect = async () => {
    setBusy("disconnect");
    const r = await disconnectTuyaAction(c.id);
    setBusy(null);
    setConfirmDisconnect(false);
    if (!r.ok) return setError(errorText(t, r.error));
    router.refresh();
    await onChanged();
  };

  const reconnect = () =>
    void linkTuyaTestAction().then(async (r) => {
      if (!r.ok) setError(errorText(t, r.error));
      await onChanged();
    });

  const pending = (hubs ?? []).flatMap((h) =>
    h.remotes.filter((m) => !m.deviceId && !m.sameAs && !added[keyOf(m)]),
  );
  const problem = needsReconnect
    ? x.problems.token
    : c.problem
      ? (x.problems[c.problem as keyof typeof x.problems] ?? x.problems.generic)
      : null;

  return (
    <div className="flex flex-col rounded-2xl border border-border bg-surface">
      <div className="px-3.5 py-3">
        <ServiceHeader
          title={x.brand}
          status={
            (problem ?? x.connectedState) + (showRegion ? ` · ${c.region.toUpperCase()}` : "")
          }
          warn={Boolean(problem)}
          actions={
            <>
              {needsReconnect &&
                (c.test ? (
                  <Button size="sm" disabled={busy !== null} onClick={reconnect}>
                    {x.reconnect}
                  </Button>
                ) : (
                  <form action={connectTuyaAction}>
                    <input type="hidden" name="region" value={c.region} />
                    <input type="hidden" name="connectionId" value={c.id} />
                    <Button type="submit" size="sm">
                      {x.reconnect}
                    </Button>
                  </form>
                ))}
              {!needsReconnect && (
                <IconAction label={x.sync} disabled={busy !== null} onClick={() => void sync()}>
                  <RotateCw
                    className={cn(
                      (busy === "sync" || busy === "load") && "motion-safe:animate-spin",
                    )}
                    aria-hidden
                  />
                </IconAction>
              )}
              <IconAction
                label={x.disconnect}
                disabled={busy !== null}
                onClick={() => setConfirmDisconnect(true)}
              >
                <Trash2 aria-hidden />
              </IconAction>
            </>
          }
        />
      </div>

      {confirmDisconnect && (
        <div
          role="alertdialog"
          aria-label={x.disconnect}
          className="mx-3.5 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2"
        >
          <p className="min-w-0 flex-1 text-[13px]">{x.disconnectConfirm}</p>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(false)}>
            {x.cancel}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy !== null}
            onClick={() => void disconnect()}
          >
            {x.disconnect}
          </Button>
        </div>
      )}

      {busy === "load" && hubs === null && (
        <p className="flex items-center gap-2 border-t border-border px-3.5 py-2.5 text-[13px] text-muted">
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
          {x.loading}
        </p>
      )}
      {hubs && !hubs.length && (
        <p className="border-t border-border px-3.5 py-2.5 text-[13px] text-muted">{x.noHubs}</p>
      )}
      {hubs?.map((h) => (
        <div key={h.id} className="border-t border-border">
          <p className="flex items-center gap-2 px-3.5 pt-2.5 text-[12px] text-faint">
            <span className="truncate" title={h.name}>
              {h.name}
            </span>
            {!h.online && <span className="shrink-0 text-approval-text">· {x.offline}</span>}
          </p>
          {h.failed && <p className="px-3.5 py-2 text-[13px] text-muted">{x.hubFailed}</p>}
          {!h.failed && !h.remotes.length && (
            <p className="px-3.5 py-2 text-[13px] text-muted">{x.noRemotes}</p>
          )}
          <ul className="flex flex-col pb-1">
            {h.remotes.map((m) => (
              <RemoteRow
                key={keyOf(m)}
                remote={m}
                added={added[keyOf(m)] ?? null}
                busy={busy !== null}
                onAdd={(replaces) => void importRemotes([m], replaces)}
              />
            ))}
          </ul>
        </div>
      ))}
      {pending.length > 1 && (
        <div className="border-t border-border px-3.5 py-2.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void importRemotes(pending)}
          >
            {x.addAll(pending.length)}
          </Button>
        </div>
      )}
      {error && (
        <p
          role="alert"
          className="border-t border-border px-3.5 py-2.5 text-[13px] text-danger-text"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function RemoteRow({
  remote,
  added,
  busy,
  onAdd,
}: {
  remote: TuyaRemoteView;
  added: Added | null;
  busy: boolean;
  onAdd: (replaces?: string) => void;
}) {
  const { t } = useI18n();
  const x = t.smartHome.setup.discover.tuya;
  const [phase, setPhase] = useState<"idle" | "confirm" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const Icon = KIND_ICON[remote.kind];
  const inHome = Boolean(remote.deviceId || added);
  const test = added?.test ?? null;
  const what = test
    ? test.type === "power"
      ? x.testWhat.power
      : (x.testWhat[test.value as keyof typeof x.testWhat] ?? test.value)
    : "";

  const send = async () => {
    if (!added || !test) return;
    setPhase("sending");
    setError(null);
    const r = await controlDeviceAction(added.id, [test]);
    const failed = !r.ok || r.value.some((o) => o.status !== "succeeded");
    if (failed) {
      setError(r.ok ? x.hubFailed : errorText(t, r.error));
      return setPhase("idle");
    }
    setPhase("sent");
  };

  return (
    <li className="flex flex-col gap-2 px-3.5 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="flex min-w-[8rem] flex-1 flex-col">
          <span className="truncate text-[14px]" title={remote.name}>
            {remote.name}
          </span>
          <span className="truncate text-[12px] text-muted">
            {x.kinds[remote.kind]}
            {remote.brand ? ` · ${remote.brand}` : ""}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {inHome ? (
            <span className="flex items-center gap-1 text-[13px] text-success">
              <Check className="size-4" aria-hidden />
              {x.inHome}
            </span>
          ) : remote.sameAs ? (
            <>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAdd()}>
                {x.addAnyway}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => onAdd(remote.sameAs!.id)}>
                {x.preferTuya}
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => onAdd()}>
              {t.smartHome.setup.discover.add}
            </Button>
          )}
          {added && test && phase === "idle" && (
            <Button size="sm" variant="secondary" onClick={() => setPhase("confirm")}>
              {x.test}
            </Button>
          )}
        </span>
      </div>
      {remote.sameAs && !inHome && (
        <p className="text-[12.5px] text-muted">{x.sameAs(remote.sameAs.name)}</p>
      )}
      {phase === "confirm" && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2">
          <p className="min-w-0 flex-1 text-[13px]">{x.testConfirm(what, remote.name)}</p>
          <Button size="sm" variant="ghost" onClick={() => setPhase("idle")}>
            {x.cancel}
          </Button>
          <Button size="sm" onClick={() => void send()}>
            {x.send}
          </Button>
        </div>
      )}
      {phase === "sending" && (
        <p className="flex items-center gap-1.5 text-[13px] text-muted">
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
          {x.sending}
        </p>
      )}
      {phase === "sent" && <p className="text-[13px] text-muted">{x.sent}</p>}
      {error && (
        <p role="alert" className="text-[13px] text-danger-text">
          {error}
        </p>
      )}
    </li>
  );
}
