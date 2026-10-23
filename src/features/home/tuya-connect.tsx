"use client";

import { Check, Cloud, Fan, Loader2, RotateCw, Snowflake, Tv } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import type { TuyaAvailability, TuyaConnection } from "@/application/tuya-connection-service";
import type { TuyaHubView, TuyaRemoteView } from "@/application/tuya-home-service";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import type { HomeRoom } from "@/core/home/model";
import type { TuyaRegion, tuyaTestAction } from "@/core/home/tuya";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import {
  connectTuyaAction,
  controlDeviceAction,
  disconnectTuyaAction,
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
 * ADR-119: "Conectar Smart Life / Tuya Smart" for anyone signed in to ELISE. The person picks
 * their account's data center and authorizes on Tuya's official page (their own login or the
 * app's QR — ELISE never sees a password); back here, each of their accounts lists its hubs →
 * the remotes already set up in Smart Life, ready to add (no learning). "Probar" sends one safe
 * key only after confirmation. Works on the web and in Desktop, with or without ELISE Home hub.
 */
export function TuyaConnect({ rooms = [] }: { rooms?: readonly HomeRoom[] }) {
  const { t } = useI18n();
  const x = t.smartHome.setup.discover.tuya;
  const params = useSearchParams();
  const [status, setStatus] = useState<{
    availability: TuyaAvailability;
    connections: TuyaConnection[];
  } | null>(null);
  const [region, setRegion] = useState<TuyaRegion | "">("");

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
  const { availability, connections } = status;
  const returned = params.get("tuya");
  const failed = params.get("tuya_error");
  const regions = availability.state === "available" ? availability.regions : [];
  const chosen = region || (regions.length === 1 ? regions[0]! : "");

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface px-3.5 py-3">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2">
          <Cloud className="size-4.5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[14.5px]">{x.title}</span>
          <span className="text-[12.5px] text-muted">{x.hint}</span>
        </span>
      </div>

      {returned === "connected" && <p className="text-[13px] text-success">{x.connected}</p>}
      {failed && (
        <p role="alert" className="text-[13px] text-danger-text">
          {x.problems[failed as keyof typeof x.problems] ?? x.problems.generic}
        </p>
      )}

      {availability.state === "unavailable" && <p className="text-[13px] text-muted">{x.notYet}</p>}

      {connections.map((c) => (
        <ConnectionCard key={c.id} connection={c} rooms={rooms} onChanged={load} />
      ))}

      {availability.state === "available" && (
        <form
          action={connectTuyaAction}
          className="flex flex-col gap-2 border-t border-border pt-3"
        >
          <p className="text-[13px] text-muted">
            {connections.length ? x.another : x.connectIntro}
          </p>
          <div className="flex flex-wrap items-center gap-2">
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
          </div>
          <p className="text-[12px] text-faint">{x.regionHint}</p>
        </form>
      )}
    </div>
  );
}

function ConnectionCard({
  connection: c,
  rooms,
  onChanged,
}: {
  connection: TuyaConnection;
  rooms: readonly HomeRoom[];
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const x = t.smartHome.setup.discover.tuya;
  const router = useRouter();
  const [hubs, setHubs] = useState<TuyaHubView[] | null>(null);
  const [others, setOthers] = useState(0);
  const [busy, setBusy] = useState<"load" | "sync" | "import" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, Added>>({});
  const [roomFor, setRoomFor] = useState<Record<string, string>>({});
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const needsReconnect = c.status === "needs_reauthorization";

  const open = async () => {
    setBusy("load");
    setError(null);
    const r = await tuyaOverviewAction(c.id);
    setBusy(null);
    if (!r.ok) {
      setError(errorText(t, r.error));
      return void onChanged();
    }
    setHubs(r.value.hubs);
    setOthers(r.value.otherDevices);
  };

  const importRemotes = async (remotes: TuyaRemoteView[], replaces?: string) => {
    setBusy("import");
    setError(null);
    const r = await tuyaImportAction({
      connectionId: c.id,
      remotes: remotes.map((m) => ({
        infraredId: m.infraredId,
        remoteId: m.remoteId,
        roomId: roomFor[keyOf(m)] || null,
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
    if (hubs) await open();
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

  const pending = (hubs ?? []).flatMap((h) =>
    h.remotes.filter((m) => !m.deviceId && !m.sameAs && !added[keyOf(m)]),
  );
  const warn = needsReconnect || c.problem;

  return (
    <div className="flex flex-col gap-2.5 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[14px] font-medium">{c.label}</span>
          <span className={warn ? "text-[12.5px] text-approval-text" : "text-[12.5px] text-muted"}>
            {needsReconnect
              ? x.problems.token
              : c.problem
                ? (x.problems[c.problem as keyof typeof x.problems] ?? x.problems.generic)
                : x.connectedState}
          </span>
        </span>
        {needsReconnect ? (
          <form action={connectTuyaAction}>
            <input type="hidden" name="region" value={c.region} />
            <input type="hidden" name="connectionId" value={c.id} />
            <Button type="submit" size="sm">
              {x.reconnect}
            </Button>
          </form>
        ) : (
          hubs === null && (
            <Button size="sm" disabled={busy !== null} onClick={() => void open()}>
              {busy === "load" && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
              {busy === "load" ? x.loading : x.showRemotes}
            </Button>
          )
        )}
        {hubs !== null && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void sync()}>
            <RotateCw
              className={busy === "sync" ? "motion-safe:animate-spin" : undefined}
              aria-hidden
            />
            {x.sync}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() => setConfirmDisconnect(true)}
        >
          {x.disconnect}
        </Button>
      </div>

      {confirmDisconnect && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2">
          <p className="flex-1 text-[13px]">{x.disconnectConfirm}</p>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(false)}>
            {x.cancel}
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => void disconnect()}>
            {x.disconnect}
          </Button>
        </div>
      )}

      {hubs && !hubs.length && <p className="text-[13px] text-muted">{x.noHubs}</p>}
      {others > 0 && <p className="text-[12.5px] text-faint">{x.others(others)}</p>}
      {hubs?.map((h) => (
        <div key={h.id} className="flex flex-col gap-2">
          <p className="text-[13.5px] font-medium">
            {h.name}
            {!h.online && <span className="font-normal text-muted"> · {x.offline}</span>}
          </p>
          {h.failed && <p className="text-[13px] text-muted">{x.hubFailed}</p>}
          {!h.failed && !h.remotes.length && (
            <p className="text-[13px] text-muted">{x.noRemotes}</p>
          )}
          <ul className="flex flex-col gap-2 pl-2">
            {h.remotes.map((m) => (
              <RemoteRow
                key={keyOf(m)}
                remote={m}
                rooms={rooms}
                room={roomFor[keyOf(m)] ?? ""}
                onRoom={(id) => setRoomFor((r) => ({ ...r, [keyOf(m)]: id }))}
                added={added[keyOf(m)] ?? null}
                busy={busy !== null}
                onAdd={(replaces) => void importRemotes([m], replaces)}
              />
            ))}
          </ul>
        </div>
      ))}
      {pending.length > 1 && (
        <Button
          className="self-start"
          disabled={busy !== null}
          onClick={() => void importRemotes(pending)}
        >
          {x.addAll(pending.length)}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

function RemoteRow({
  remote,
  rooms,
  room,
  onRoom,
  added,
  busy,
  onAdd,
}: {
  remote: TuyaRemoteView;
  rooms: readonly HomeRoom[];
  room: string;
  onRoom: (id: string) => void;
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
    <li className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Icon className="size-4 shrink-0 text-muted" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px]">{remote.name}</span>
          <span className="text-[12px] text-muted">
            {x.kinds[remote.kind]}
            {remote.brand ? ` · ${remote.brand}` : ""}
          </span>
        </span>
        {!inHome && rooms.length > 0 && (
          <Select
            aria-label={x.room(remote.name)}
            value={room}
            onChange={(e) => onRoom(e.target.value)}
            className="h-9 w-36"
          >
            <option value="">{x.noRoom}</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        )}
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
      </div>
      {remote.sameAs && !inHome && (
        <p className="text-[12.5px] text-muted">{x.sameAs(remote.sameAs.name)}</p>
      )}
      {phase === "confirm" && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-2">
          <p className="flex-1 text-[13px]">{x.testConfirm(what, remote.name)}</p>
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
