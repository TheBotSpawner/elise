"use client";

import { Check, Cloud, Fan, Loader2, Snowflake, Tv } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { TuyaLinkState, TuyaRemoteView } from "@/application/tuya-home-service";
import { Button } from "@/components/ui/button";
import type { tuyaTestAction } from "@/core/home/tuya";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { controlDeviceAction, tuyaImportAction, tuyaOverviewAction } from "./actions";

type Hub = {
  id: string;
  name: string;
  online: boolean;
  failed: boolean;
  remotes: TuyaRemoteView[];
};
type Test = NonNullable<ReturnType<typeof tuyaTestAction>>;
type Added = { id: string; name: string; infraredId: string; remoteId: string; test: Test | null };

const KIND_ICON = { tv: Tv, ac: Snowflake, fan: Fan, other: Cloud } as const;
const keyOf = (r: Pick<TuyaRemoteView, "infraredId" | "remoteId">) =>
  `${r.infraredId}:${r.remoteId}`;

/**
 * ADR-118: "Conectar Tuya / Smart Life" in "Buscar dispositivos". Hub → the remotes already set
 * up in Smart Life; adding one makes it a ready device (no learning). "Probar" sends one safe key
 * only after the person confirms. Nothing shows when Smart Life is off on this server.
 */
export function TuyaConnect() {
  const { t } = useI18n();
  const x = t.smartHome.setup.discover.tuya;
  const router = useRouter();
  const [link, setLink] = useState<TuyaLinkState | null>(null);
  const [hubs, setHubs] = useState<Hub[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, Added>>({});
  const [skipped, setSkipped] = useState(0);

  useEffect(() => {
    let live = true;
    void tuyaOverviewAction(false).then((r) => live && r.ok && setLink(r.value.link));
    return () => {
      live = false;
    };
  }, []);

  if (!link || link.state === "off") return null;

  const open = async () => {
    setBusy(true);
    setError(null);
    const r = await tuyaOverviewAction(true);
    setBusy(false);
    if (!r.ok) return setError(errorText(t, r.error));
    setLink(r.value.link);
    setHubs(r.value.hubs);
  };

  const importRemotes = async (remotes: TuyaRemoteView[]) => {
    setBusy(true);
    setError(null);
    const r = await tuyaImportAction(
      remotes.map((m) => ({ infraredId: m.infraredId, remoteId: m.remoteId })),
    );
    setBusy(false);
    if (!r.ok) return setError(errorText(t, r.error));
    setAdded((m) => ({ ...m, ...Object.fromEntries(r.value.added.map((a) => [keyOf(a), a])) }));
    setSkipped(r.value.skipped.length);
    router.refresh();
  };

  const pending = (hubs ?? []).flatMap((h) =>
    h.remotes.filter((m) => !m.deviceId && !m.sameAs && !added[keyOf(m)]),
  );

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
        {link.state === "linked" && hubs === null && (
          <Button size="sm" disabled={busy} onClick={() => void open()}>
            {busy && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
            {busy ? x.loading : x.connect}
          </Button>
        )}
      </div>

      {link.state === "not_configured" && (
        <p className="text-[13px] text-muted">{x.notConfigured}</p>
      )}
      {link.state === "not_linked" && <p className="text-[13px] text-muted">{x.notLinked}</p>}

      {hubs && !hubs.length && <p className="text-[13px] text-muted">{x.noHubs}</p>}
      {hubs?.map((h) => (
        <div key={h.id} className="flex flex-col gap-2 border-t border-border pt-3">
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
                added={added[keyOf(m)] ?? null}
                busy={busy}
                onAdd={() => void importRemotes([m])}
              />
            ))}
          </ul>
        </div>
      ))}
      {pending.length > 1 && (
        <Button className="self-start" disabled={busy} onClick={() => void importRemotes(pending)}>
          {x.addAll(pending.length)}
        </Button>
      )}
      {skipped > 0 && <p className="text-[13px] text-muted">{x.skipped(skipped)}</p>}
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
  added,
  busy,
  onAdd,
}: {
  remote: TuyaRemoteView;
  added: Added | null;
  busy: boolean;
  onAdd: () => void;
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
      <div className="flex items-center gap-3">
        <Icon className="size-4 shrink-0 text-muted" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px]">{remote.name}</span>
          <span className="text-[12px] text-muted">
            {x.kinds[remote.kind]}
            {remote.brand ? ` · ${remote.brand}` : ""}
          </span>
        </span>
        {inHome ? (
          <span className="flex items-center gap-1 text-[13px] text-success">
            <Check className="size-4" aria-hidden />
            {x.inHome}
          </span>
        ) : (
          <Button
            size="sm"
            variant={remote.sameAs ? "ghost" : "primary"}
            disabled={busy}
            onClick={onAdd}
          >
            {remote.sameAs ? x.addAnyway : t.smartHome.setup.discover.add}
          </Button>
        )}
        {added && test && phase === "idle" && (
          <Button size="sm" variant="secondary" onClick={() => setPhase("confirm")}>
            {x.test}
          </Button>
        )}
      </div>
      {remote.sameAs && !inHome && (
        <p className="text-[12.5px] text-muted">{x.sameAs(remote.sameAs)}</p>
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
