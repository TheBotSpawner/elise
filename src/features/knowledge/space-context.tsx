"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { updateSpaceContextAction } from "./actions";

/**
 * "Contexto": what this Space or Section is about, in the user's own words. ELISE reads it as
 * background whenever it works here; it never grants access or changes rules.
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
  const [value, setValue] = useState(initial ?? "");
  const [saved, setSaved] = useState(initial ?? "");
  const [pending, startTransition] = useTransition();
  const dirty = value.trim() !== saved.trim();

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await updateSpaceContextAction(spaceId, value);
      if (!r.ok) return void toast.error(errorText(t, r.error));
      setSaved(value);
      toast.success(k.saved);
      router.refresh();
    });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <label htmlFor={`space-context-${spaceId}`} className="type-label text-faint">
        {k.title}
      </label>
      <p className="text-[13px] text-muted">{isSection ? k.hintSection : k.hintSpace}</p>
      <textarea
        id={`space-context-${spaceId}`}
        value={value}
        maxLength={4000}
        rows={4}
        placeholder={isSection ? k.placeholderSection : k.placeholderSpace}
        onChange={(e) => setValue(e.target.value)}
        className="min-h-24 w-full resize-y rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg transition-colors placeholder:text-faint hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none"
      />
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" disabled={!dirty || pending}>
          {pending ? t.common.loading : k.save}
        </Button>
      </div>
    </form>
  );
}
