"use client";

import { Play, Plus, Trash2, X, Zap } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/shared/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { THEMES } from "@/core/capabilities/settings";
import type { PublicError } from "@/core/errors";
import {
  SHORTCUT_LIMITS,
  STEP_TYPE_KEYS,
  type Shortcut,
  type StepType,
} from "@/core/shortcuts/model";
import { STUDY_MODES } from "@/core/study/model";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import {
  createShortcutAction,
  deleteShortcutAction,
  setShortcutEnabledAction,
  updateShortcutAction,
} from "./actions";

type Step = { type: StepType; config: Record<string, unknown> };

interface Draft {
  id: string | null;
  name: string;
  phrases: string;
  steps: Step[];
  contextId: string;
  requiresConfirmation: boolean;
}

const EMPTY: Draft = {
  id: null,
  name: "",
  phrases: "",
  steps: [{ type: "morning_brief.run", config: {} }],
  contextId: "",
  requiresConfirmation: false,
};

/** Default parameters for a step (the registry fills the rest). */
function defaults(type: StepType): Record<string, unknown> {
  if (type === "study.start") return { mode: "oral_exam" };
  if (type === "work.brief") return { web: false };
  if (type === "finance.show_summary") return { period: "this_month" };
  if (type === "appearance.set_theme") return { theme: "dark" };
  return {};
}

/** Shortcuts: user-defined phrases for workflows ELISE already has (ADR-017). */
export function ShortcutsView({
  shortcuts,
  contexts,
}: {
  shortcuts: Shortcut[];
  contexts: { id: string; name: string }[];
}) {
  const { t } = useI18n();
  const sc = t.shortcuts;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, start] = useTransition();

  const act = (
    fn: () => Promise<{ ok: true } | { ok: false; error: PublicError }>,
    done?: () => void,
  ) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(errorText(t, r.error));
      else done?.();
    });

  function save(d: Draft) {
    const input = {
      name: d.name,
      phrases: d.phrases
        .split(/[,\n]/)
        .map((p) => p.trim())
        .filter(Boolean),
      steps: d.steps,
      contextId: d.contextId || null,
      requiresConfirmation: d.requiresConfirmation,
    };
    act(
      () => (d.id ? updateShortcutAction(d.id, input) : createShortcutAction(input)),
      () => {
        setDraft(null);
        toast.success(sc.saved);
      },
    );
  }

  const contextName = (id: string | null) => contexts.find((c) => c.id === id)?.name ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted">{sc.hint}</p>
        {!draft && (
          <Button size="sm" onClick={() => setDraft(EMPTY)}>
            <Plus aria-hidden />
            {sc.new}
          </Button>
        )}
      </div>

      {draft && (
        <ShortcutForm
          draft={draft}
          contexts={contexts}
          pending={pending}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={save}
        />
      )}

      {shortcuts.length === 0 && !draft && (
        <EmptyState
          icon={Zap}
          title={sc.emptyTitle}
          body={sc.empty}
          action={
            <Button onClick={() => setDraft(EMPTY)}>
              <Plus className="size-4" aria-hidden />
              {sc.new}
            </Button>
          }
        />
      )}

      <ul className="flex flex-col gap-3">
        {shortcuts.map((s) => (
          <li key={s.id}>
            <Card className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    <Zap className="size-4 text-accent" aria-hidden />
                    {s.name}
                  </p>
                  <p className="mt-1 flex flex-wrap gap-1.5">
                    {s.phrases.map((p) => (
                      <span
                        key={p}
                        className="rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 text-[12px] text-accent-text"
                      >
                        “{p}”
                      </span>
                    ))}
                  </p>
                </div>
                <Switch
                  checked={s.enabled}
                  disabled={pending}
                  aria-label={sc.enabled}
                  onCheckedChange={(on) => act(() => setShortcutEnabledAction(s.id, on))}
                />
              </div>
              <ol className="flex flex-col gap-0.5 text-[13.5px] text-muted">
                {s.steps.map((step, i) => (
                  <li key={i}>
                    {i + 1}. {sc.steps[step.type]}
                  </li>
                ))}
              </ol>
              <p className="text-[12.5px] text-faint">
                {[
                  contextName(s.contextId) && sc.forContext(contextName(s.contextId)!),
                  s.requiresConfirmation && sc.asksFirst,
                  s.runCount > 0 && sc.runs(s.runCount),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <div className="flex flex-wrap gap-2">
                {s.enabled && (
                  <Link
                    href={`/?run=${s.id}`}
                    className={buttonVariants({ variant: "secondary", size: "sm" })}
                  >
                    <Play aria-hidden />
                    {sc.run}
                  </Link>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDraft({
                      id: s.id,
                      name: s.name,
                      phrases: s.phrases.join(", "),
                      steps: s.steps,
                      contextId: s.contextId ?? "",
                      requiresConfirmation: s.requiresConfirmation,
                    })
                  }
                >
                  {sc.edit}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm(sc.deleteConfirm(s.name)))
                      act(() => deleteShortcutAction(s.id));
                  }}
                >
                  <Trash2 aria-hidden />
                  {sc.delete}
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ShortcutForm({
  draft,
  contexts,
  pending,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  contexts: { id: string; name: string }[];
  pending: boolean;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: (d: Draft) => void;
}) {
  const { t } = useI18n();
  const sc = t.shortcuts;
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setStep = (i: number, step: Step) =>
    set({ steps: draft.steps.map((s, j) => (j === i ? step : s)) });

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="sc-name">{sc.name}</Label>
          <Input
            id="sc-name"
            value={draft.name}
            maxLength={80}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sc-phrases">{sc.phrases}</Label>
          <Input
            id="sc-phrases"
            value={draft.phrases}
            placeholder={sc.phrasesPlaceholder}
            onChange={(e) => set({ phrases: e.target.value })}
          />
          <p className="text-[12px] text-faint">{sc.phrasesHint}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{sc.stepsLabel}</Label>
        {draft.steps.map((step, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <span className="w-4 text-[13px] text-faint tabular-nums">{i + 1}.</span>
            <Select
              aria-label={sc.stepsLabel}
              value={step.type}
              className="w-auto min-w-56 flex-1"
              onChange={(e) => {
                const type = e.target.value as StepType;
                setStep(i, { type, config: defaults(type) });
              }}
            >
              {STEP_TYPE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {sc.steps[k]}
                </option>
              ))}
            </Select>
            <StepParams step={step} onChange={(s) => setStep(i, s)} />
            {draft.steps.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={sc.removeStep}
                onClick={() => set({ steps: draft.steps.filter((_, j) => j !== i) })}
              >
                <X aria-hidden />
              </Button>
            )}
          </div>
        ))}
        {draft.steps.length < SHORTCUT_LIMITS.steps && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() =>
              set({ steps: [...draft.steps, { type: "tasks.show_today", config: {} }] })
            }
          >
            <Plus aria-hidden />
            {sc.addStep}
          </Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="sc-context">{sc.context}</Label>
          <Select
            id="sc-context"
            value={draft.contextId}
            onChange={(e) => set({ contextId: e.target.value })}
          >
            <option value="">{sc.noContext}</option>
            {contexts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-[14px]">
          <input
            type="checkbox"
            checked={draft.requiresConfirmation}
            onChange={(e) => set({ requiresConfirmation: e.target.checked })}
            className="size-4 accent-[var(--color-accent)]"
          />
          {sc.requiresConfirmation}
        </label>
      </div>
      <p className="text-[12.5px] text-faint">{sc.safety}</p>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {sc.cancel}
        </Button>
        <Button
          disabled={pending || !draft.name.trim() || !draft.phrases.trim()}
          onClick={() => onSave(draft)}
        >
          {sc.save}
        </Button>
      </div>
    </Card>
  );
}

/** The few parameters a step has; everything else comes from context. */
function StepParams({ step, onChange }: { step: Step; onChange: (s: Step) => void }) {
  const { t } = useI18n();
  const p = t.shortcuts.params;
  const set = (k: string, v: unknown) => onChange({ ...step, config: { ...step.config, [k]: v } });
  switch (step.type) {
    case "study.start":
      return (
        <Select
          aria-label={p.mode}
          className="w-auto"
          value={String(step.config.mode ?? "oral_exam")}
          onChange={(e) => set("mode", e.target.value)}
        >
          {STUDY_MODES.map((m) => (
            <option key={m} value={m}>
              {p.modes[m]}
            </option>
          ))}
        </Select>
      );
    case "work.brief":
      return (
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <input
            type="checkbox"
            checked={Boolean(step.config.web)}
            onChange={(e) => set("web", e.target.checked)}
            className="size-4 accent-[var(--color-accent)]"
          />
          {p.web}
        </label>
      );
    case "finance.show_summary":
      return (
        <Select
          aria-label={p.period}
          className="w-auto"
          value={String(step.config.period ?? "this_month")}
          onChange={(e) => set("period", e.target.value)}
        >
          {(["this_week", "this_month", "last_month"] as const).map((x) => (
            <option key={x} value={x}>
              {p.periods[x]}
            </option>
          ))}
        </Select>
      );
    case "appearance.set_theme":
      return (
        <Select
          aria-label={p.theme}
          className="w-auto"
          value={String(step.config.theme ?? "dark")}
          onChange={(e) => set("theme", e.target.value)}
        >
          {THEMES.map((x) => (
            <option key={x} value={x}>
              {t.settings.themes[x]}
            </option>
          ))}
        </Select>
      );
    default:
      return null;
  }
}
