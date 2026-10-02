"use client";

import { ChevronDown, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { updateSpaceContextAction } from "./actions";

/**
 * "Contexto": what this Space or Section is about, in the user's own words. ELISE reads it as
 * background whenever it works here; it never grants access or changes rules. Compact by
 * default — one summary line — and an editor only while the user is editing.
 */
export function SpaceContext({
  spaceId,
  initial,
  isSection,
}: {
  spaceId: string;
  initial: string | null;
  isSection: boolean;
}) {
  const { t } = useI18n();
  const k = t.knowledge.context;
  const router = useRouter();
  const fieldId = useId();
  const [saved, setSaved] = useState(initial ?? "");
  const [value, setValue] = useState(initial ?? "");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const dirty = value.trim() !== saved.trim();

  function close() {
    if (dirty && !window.confirm(k.discard)) return;
    setValue(saved);
    setOpen(false);
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await updateSpaceContextAction(spaceId, value);
      if (!r.ok) return void toast.error(errorText(t, r.error));
      setSaved(value.trim());
      setValue(value.trim());
      setOpen(false);
      toast.success(k.saved);
      router.refresh();
    });
  }

  if (!open) {
    const summary = saved.replace(/\s+/g, " ").trim();
    return (
      <section aria-labelledby={`${fieldId}-label`} className="flex flex-col gap-1">
        <h2 id={`${fieldId}-label`} className="type-label text-faint">
          {k.title}
        </h2>
        {summary ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-expanded={false}
            aria-label={k.edit}
            className="group -mx-2 flex items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-active"
          >
            <span className="line-clamp-1 min-w-0 flex-1 text-[14px] text-fg2">{summary}</span>
            <Pencil className="size-3.5 shrink-0 text-faint group-hover:text-fg" aria-hidden />
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-[13.5px] text-muted">{isSection ? k.emptySection : k.emptySpace}</p>
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              <Plus />
              {k.add}
            </Button>
          </div>
        )}
      </section>
    );
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor={fieldId} className="type-label text-faint">
          {k.title}
        </label>
        <button
          type="button"
          onClick={close}
          aria-expanded
          aria-label={k.collapse}
          className="ml-auto grid size-7 place-items-center rounded-full text-faint hover:bg-active hover:text-fg"
        >
          <ChevronDown className="size-4 rotate-180" aria-hidden />
        </button>
      </div>
      <p className="text-[13px] text-muted">{isSection ? k.hintSection : k.hintSpace}</p>
      <textarea
        id={fieldId}
        value={value}
        maxLength={4000}
        rows={3}
        autoFocus
        placeholder={isSection ? k.placeholderSection : k.placeholderSpace}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="min-h-20 w-full resize-y rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg transition-colors placeholder:text-faint hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={close} disabled={pending}>
          {k.cancel}
        </Button>
        <Button type="submit" variant="secondary" disabled={!dirty || pending}>
          {pending ? t.common.loading : k.save}
        </Button>
      </div>
    </form>
  );
}
