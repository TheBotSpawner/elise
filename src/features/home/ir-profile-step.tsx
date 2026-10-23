"use client";

import { Check, Loader2, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProfileEntry } from "@/core/home/ir-profiles";
import type { IrKind } from "@/core/home/model";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import {
  applyIrProfileAction,
  controlDeviceAction,
  irCommandAction,
  irProfilesAction,
} from "./actions";

type Phase =
  | { kind: "search" }
  | { kind: "testing"; at: number; test: string }
  | { kind: "asking"; at: number; test: string }
  | { kind: "works" }
  | { kind: "none" };

/**
 * ADR-117: before any learning, a published profile for the brand/model — applied, one button
 * pressed by ELISE, and kept only if the person says the device reacted. The next candidate is
 * tried on "No". The BroadLink app's own remotes can't be imported (no official export): this
 * says so instead of promising it.
 */
export function IrProfileStep({
  deviceId,
  deviceName,
  kind,
  onWorks,
  onLearn,
  onSkip,
}: {
  deviceId: string;
  deviceName: string;
  kind: Exclude<IrKind, "other">;
  onWorks: () => void;
  onLearn: () => void;
  onSkip: () => void;
}) {
  const { t } = useI18n();
  const x = t.smartHome.ir.profile;
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProfileEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "search" });

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    const r = await irProfilesAction(kind, query);
    setBusy(false);
    if (!r.ok) return setError(errorText(t, r.error));
    setResults(r.value.profiles);
  };

  const tryAt = async (list: readonly ProfileEntry[], at: number) => {
    const entry = list[at];
    if (!entry) return setPhase({ kind: "none" });
    setBusy(true);
    setError(null);
    const applied = await applyIrProfileAction(deviceId, entry.code);
    if (!applied.ok || !applied.value.test) {
      setBusy(false);
      return void tryAt(list, at + 1);
    }
    const test = applied.value.test;
    setPhase({ kind: "testing", at, test });
    const sent = await controlDeviceAction(deviceId, [{ type: "button", value: test }]);
    setBusy(false);
    if (!sent.ok) {
      setError(errorText(t, sent.error));
      return setPhase({ kind: "search" });
    }
    setPhase({ kind: "asking", at, test });
  };

  const answer = async (worked: boolean) => {
    if (phase.kind !== "asking" || !results) return;
    if (!worked) return void tryAt(results, phase.at + 1);
    await irCommandAction(deviceId, { op: "verify", key: phase.test, worked: true });
    setPhase({ kind: "works" });
    router.refresh();
  };

  const current = phase.kind === "asking" || phase.kind === "testing" ? results?.[phase.at] : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-2xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">{x.noImport}</p>

      {phase.kind === "search" && (
        <>
          <p className="text-[14px]">{x.intro(deviceName)}</p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Input
              value={query}
              autoFocus
              maxLength={80}
              placeholder={x.placeholder[kind]}
              aria-label={x.placeholder[kind]}
              onChange={(e) => setQuery(e.target.value)}
              className="h-10 flex-1"
            />
            <Button type="submit" size="sm" disabled={busy || !query.trim()}>
              {busy ? (
                <Loader2 className="motion-safe:animate-spin" aria-hidden />
              ) : (
                <Search aria-hidden />
              )}
              {x.search}
            </Button>
          </form>
          {results && !results.length && <p className="text-[13.5px] text-muted">{x.noResults}</p>}
          {results && results.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-[13px] text-muted">{x.found(results.length)}</p>
              <ul className="flex flex-col gap-1.5">
                {results.slice(0, 8).map((r) => (
                  <li
                    key={r.code}
                    className="rounded-xl border border-border px-3 py-2 text-[13.5px]"
                  >
                    <span className="font-medium">{r.brand}</span>{" "}
                    <span className="text-muted">{r.models.slice(0, 3).join(" · ")}</span>
                  </li>
                ))}
              </ul>
              <Button className="self-start" disabled={busy} onClick={() => void tryAt(results, 0)}>
                {x.test}
              </Button>
            </div>
          )}
        </>
      )}

      {(phase.kind === "testing" || phase.kind === "asking") && current && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted">
            {x.trying(
              phase.at + 1,
              results?.length ?? 1,
              `${current.brand} ${current.models[0] ?? ""}`,
            )}
          </p>
          {phase.kind === "testing" ? (
            <p className="flex items-center gap-2 text-[14px]">
              <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
              {x.sending}
            </p>
          ) : (
            <>
              <p className="text-[15px] font-medium">{x.question(deviceName, phase.test)}</p>
              <div className="flex gap-2">
                <Button onClick={() => void answer(true)}>{x.yes}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => void answer(false)}>
                  {x.no}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {phase.kind === "works" && (
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-[14.5px] text-success">
            <Check className="size-4" aria-hidden />
            {x.works(deviceName)}
          </p>
          <p className="text-[12.5px] text-muted">{x.credit}</p>
          <Button className="self-start" onClick={onWorks}>
            {x.done}
          </Button>
        </div>
      )}

      {phase.kind === "none" && <p className="text-[14px]">{x.noneWorked}</p>}

      {error && (
        <p role="alert" className="text-[13px] text-danger-text">
          {error}
        </p>
      )}

      {phase.kind !== "works" && (
        <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-3">
          <Button variant="ghost" onClick={onSkip}>
            {x.skip}
          </Button>
          {/* Learning is the last resort: only when no published profile exists or none worked. */}
          {(phase.kind === "none" || (results !== null && !results.length)) && (
            <Button variant="secondary" onClick={onLearn}>
              {x.learn}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
