"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
  setMemoryEnabledAction,
} from "./actions";
import { SettingRow, SettingsCard } from "./shell";

/**
 * Memory (ADR-068): one switch and a readable list of what ELISE keeps in mind — never chunks
 * or embeddings. Each fact says where it came from and can be edited or forgotten.
 */
export function MemorySettings({ enabled, facts }: { enabled: boolean; facts: MemoryFact[] }) {
  const { t } = useI18n();
  const m = t.settingsHub.memory;
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: { code: string } }>) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(errorText(t, r.error as never));
    });

  return (
    <div className="flex flex-col gap-6">
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
      </SettingsCard>

      <section id="summary" className="settings-row flex scroll-mt-24 flex-col gap-2">
        <div className="flex items-end justify-between gap-3 px-1">
          <div>
            <h2 className="type-label text-faint">{m.summary}</h2>
            <p className="mt-1 text-[13px] text-muted">
              {facts.length ? m.count(facts.length) : m.summaryHint}
            </p>
          </div>
          {!adding && (
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
            facts.map((f) => <FactRow key={f.id} fact={f} />)
          )}
        </div>
        {facts.length > 0 && (
          <button
            type="button"
            disabled={pending}
            onClick={() => window.confirm(m.clearConfirm) && run(clearMemoryAction)}
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

function FactRow({ fact }: { fact: MemoryFact }) {
  const { t } = useI18n();
  const m = t.settingsHub.memory;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(fact.value);
  const [pending, start] = useTransition();
  const provenance = [
    fact.sources.length ? m.fromConversation(fact.sources.length) : m.fromSettings,
    fact.confidence === "inferred" ? m.inferred : null,
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
        <p className="mt-0.5 text-[12px] text-faint">{provenance}</p>
      </div>
      <div className="flex shrink-0 gap-0.5 md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100">
        <button
          type="button"
          aria-label={`${m.edit}: ${label(fact.key)}`}
          onClick={() => setEditing(true)}
          className="grid size-10 place-items-center rounded-full text-muted hover:bg-active hover:text-fg md:size-8"
        >
          <Pencil className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`${m.forget}: ${label(fact.key)}`}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await forgetMemoryAction(fact.id);
              if (!r.ok) toast.error(errorText(t, r.error));
            })
          }
          className="grid size-10 place-items-center rounded-full text-muted hover:bg-active hover:text-danger-text md:size-8"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
