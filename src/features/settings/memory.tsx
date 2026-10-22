"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { MemoryState } from "@/application/memory-service";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { MemoryFact } from "@/core/memory/model";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import {
  addMemoryAction,
  clearMemoryAction,
  editMemoryAction,
  forgetMemoryAction,
  setLearningAction,
  setMemoryEnabledAction,
} from "./actions";
import { SettingRow, SettingsCard } from "./shell";

type Result = { ok: true } | { ok: false; error: { code: string } };

/**
 * Memory (ADR-068, ADR-107): the switch, learning from conversations (opt-in), the profile,
 * and a readable list of what ELISE keeps in mind — never chunks or embeddings. Each fact says
 * where it came from, how sure ELISE is and when it was confirmed; it can be edited or
 * forgotten for good.
 */
export function MemorySettings({
  state,
  conversations,
  recent: recentIds,
}: {
  state: MemoryState;
  /** Source ids that are conversations the person can open. */
  conversations: string[];
  /** Facts learned recently (newest first), shown on their own. */
  recent: string[];
}) {
  const { t, locale } = useI18n();
  const m = t.settingsHub.memory;
  const confirm = useConfirm();
  const [on, setOn] = useState(state.enabled);
  const [learning, setLearning] = useState(state.learning.on);
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const readOnly = state.upgrading;
  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(new Date(iso));
  const usd = (n: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(n);

  const run = (fn: () => Promise<Result>, done?: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(errorText(t, r.error as never));
      else if (done) toast(done);
    });

  const facts = state.facts;
  const recent = recentIds.flatMap((id) => facts.filter((f) => f.id === id));
  const linkable = new Set(conversations);

  const learnStatus = !state.learning.available
    ? m.learnUnavailable[state.learning.unavailable ?? "rollout"]
    : learning
      ? [
          state.learning.since ? m.learnSince(day(state.learning.since)) : null,
          m.spend(usd(state.spend.usd), usd(state.spend.cap)),
        ]
          .filter(Boolean)
          .join(" ")
      : null;

  return (
    <div className="flex flex-col gap-6">
      {readOnly && (
        <p className="rounded-xl border border-approval-line bg-approval-bg px-4 py-3 text-[13px] text-approval-text">
          {m.upgrading}
        </p>
      )}
      <SettingsCard>
        <SettingRow id="use-memory" label={m.use} hint={m.useHint} info={m.info}>
          <Switch
            checked={on}
            aria-label={m.use}
            disabled={pending}
            onCheckedChange={(next) => {
              setOn(next);
              run(() => setMemoryEnabledAction(next));
            }}
          />
        </SettingRow>
        <SettingRow
          id="learn"
          label={m.learn}
          hint={
            <>
              {m.learnHint}
              {learnStatus && <span className="mt-1 block text-faint">{learnStatus}</span>}
            </>
          }
          info={m.learnInfo}
        >
          <Switch
            checked={learning}
            aria-label={m.learn}
            disabled={pending || readOnly || !on || (!state.learning.available && !learning)}
            onCheckedChange={(next) => {
              setLearning(next);
              run(() => setLearningAction(next));
            }}
          />
        </SettingRow>
      </SettingsCard>

      {state.profile.length > 0 && (
        <section id="profile" className="settings-row flex scroll-mt-24 flex-col gap-2">
          <div className="px-1">
            <h2 className="type-label text-faint">{m.profile}</h2>
            <p className="mt-1 text-[13px] text-muted">{m.profileHint}</p>
          </div>
          <ul className="flex flex-col gap-1.5 rounded-2xl border border-border bg-surface px-5 py-4 text-[14px]">
            {state.profile.map((l) => (
              <li key={l.text}>{l.text}</li>
            ))}
          </ul>
        </section>
      )}

      {recent.length > 0 && (
        <section id="recent" className="settings-row flex scroll-mt-24 flex-col gap-2">
          <h2 className="px-1 type-label text-faint">{m.recent}</h2>
          <div className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
            {recent.map((f) => (
              <FactRow key={f.id} fact={f} linkable={linkable} readOnly={readOnly} day={day} />
            ))}
          </div>
        </section>
      )}

      <section id="summary" className="settings-row flex scroll-mt-24 flex-col gap-2">
        <div className="flex items-end justify-between gap-3 px-1">
          <div>
            <h2 className="type-label text-faint">{m.summary}</h2>
            <p className="mt-1 text-[13px] text-muted">
              {facts.length ? m.count(facts.length) : m.summaryHint}
            </p>
          </div>
          {!adding && !readOnly && (
            <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
              <Plus />
              {m.add}
            </Button>
          )}
        </div>
        {!on && (
          <p className="rounded-xl border border-dashed border-border px-4 py-3 text-[13px] text-muted">
            {m.off}
          </p>
        )}
        <div className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
          {adding && <AddFact onDone={() => setAdding(false)} />}
          {facts.length === 0 && !adding ? (
            <p className="px-5 py-6 text-center text-[13.5px] text-muted">{m.empty}</p>
          ) : (
            facts.map((f) => (
              <FactRow key={f.id} fact={f} linkable={linkable} readOnly={readOnly} day={day} />
            ))
          )}
        </div>
        {facts.length > 0 && !readOnly && (
          <button
            type="button"
            disabled={pending}
            onClick={async () => {
              if (
                await confirm({
                  title: m.clearConfirm,
                  body: m.clearBody,
                  confirmLabel: m.clear,
                  destructive: true,
                })
              )
                run(clearMemoryAction);
            }}
            className="self-start rounded-full px-2 py-1.5 text-[13px] text-muted hover:text-danger-text"
          >
            {m.clear}
          </button>
        )}
      </section>
    </div>
  );
}

function AddFact({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const m = t.settingsHub.memory;
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-col gap-3 p-4 md:p-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addMemoryAction({ key, value });
          if (!r.ok) return void toast.error(errorText(t, r.error));
          onDone();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Input
          aria-label={m.key}
          placeholder={m.keyPlaceholder}
          value={key}
          maxLength={60}
          required
          data-autofocus
          onChange={(e) => setKey(e.target.value)}
        />
        <Input
          aria-label={m.value}
          placeholder={m.valuePlaceholder}
          value={value}
          maxLength={300}
          required
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={pending}>
          {m.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={pending || !key.trim() || !value.trim()}>
          {m.save}
        </Button>
      </div>
    </form>
  );
}

const label = (key: string) => {
  const last = key.split(".").at(-1) ?? key;
  const words = last.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function FactRow({
  fact,
  linkable,
  readOnly,
  day,
}: {
  fact: MemoryFact;
  linkable: ReadonlySet<string>;
  readOnly: boolean;
  day: (iso: string) => string;
}) {
  const { t } = useI18n();
  const m = t.settingsHub.memory;
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(fact.value);
  const [pending, start] = useTransition();
  const source = fact.sources.find((s) => linkable.has(s));
  const provenance = [
    m.provenance[fact.provenance],
    fact.provenance === "inferred" ? m.certainty(Math.round(fact.certainty * 100)) : null,
    m.confirmed(day(fact.lastConfirmedAt)),
    fact.corroborations > 1 ? m.times(fact.corroborations) : null,
    fact.learned ? m.learned : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (editing)
    return (
      <form
        className="flex flex-col gap-2 p-4 md:p-5"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await editMemoryAction(fact.id, value);
            if (!r.ok) return void toast.error(errorText(t, r.error));
            setEditing(false);
          });
        }}
      >
        <p className="text-[13px] text-muted">{label(fact.key)}</p>
        <Input
          aria-label={label(fact.key)}
          value={value}
          maxLength={300}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEditing(false)}
            disabled={pending}
          >
            {m.cancel}
          </Button>
          <Button type="submit" size="sm" disabled={pending || !value.trim()}>
            {m.save}
          </Button>
        </div>
      </form>
    );
  return (
    <div className="group flex items-start gap-3 px-4 py-3 md:px-5">
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] text-faint">{label(fact.key)}</p>
        <p className="text-[14.5px]">{fact.value}</p>
        <p className="mt-0.5 text-[12px] text-faint">
          {provenance}
          {source && (
            <>
              {" · "}
              <Link
                href={`/chat/${source}`}
                className="underline-offset-2 hover:text-fg hover:underline"
              >
                {m.viewSource}
              </Link>
            </>
          )}
        </p>
      </div>
      {!readOnly && (
        // Always visible (it was hover-only and went unnoticed): forgetting one fact is a
        // first-class action, not a hidden one.
        <div className="flex shrink-0 gap-0.5">
          <button
            type="button"
            aria-label={`${m.edit}: ${label(fact.key)}`}
            onClick={() => setEditing(true)}
            className="grid size-10 place-items-center rounded-full text-faint hover:bg-active hover:text-fg md:size-8"
          >
            <Pencil className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={`${m.forget}: ${label(fact.key)}`}
            disabled={pending}
            onClick={async () => {
              if (
                !(await confirm({
                  title: m.forgetTitle,
                  body: m.forgetBody,
                  confirmLabel: m.forget,
                  destructive: true,
                }))
              )
                return;
              start(async () => {
                const r = await forgetMemoryAction(fact.id);
                if (!r.ok) toast.error(errorText(t, r.error));
                else toast(m.forgotten);
              });
            }}
            className="grid size-10 place-items-center rounded-full text-faint hover:bg-active hover:text-danger-text md:size-8"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
