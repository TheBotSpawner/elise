"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { SECTION_PURPOSES, type SectionPurpose } from "@/core/contexts/model";
import {
  DEFAULT_SPACE_COLOR,
  DEFAULT_SPACE_ICON,
  suggestAppearance,
  type SpaceColor,
  type SpaceIcon,
} from "@/core/knowledge/appearance";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { createSectionAction } from "./actions";
import { AppearancePicker, SpaceGlyph } from "./appearance";

/**
 * "+ New section" (ADR-018): a name, what it's for, and a look. Its context — study progress,
 * client intelligence — comes with it; nothing else to set up.
 */
export function SectionDialog({
  open,
  onClose,
  parent,
}: {
  open: boolean;
  onClose: () => void;
  parent: { id: string; name: string; color: SpaceColor };
}) {
  const { t } = useI18n();
  const s = t.knowledge.sections;
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [purpose, setPurpose] = useState<SectionPurpose>("general");
  const [look, setLook] = useState<{ icon: SpaceIcon; color: SpaceColor }>({
    icon: DEFAULT_SPACE_ICON,
    color: parent.color ?? DEFAULT_SPACE_COLOR,
  });
  const [lookTouched, setLookTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setName("");
    setDescription("");
    setPurpose("general");
    setLookTouched(false);
    setError(null);
    onClose();
  };

  async function create() {
    setBusy(true);
    setError(null);
    const r = await createSectionAction({
      parentId: parent.id,
      name,
      description: description.trim() || null,
      icon: look.icon,
      color: look.color,
      purpose,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message || t.errors.codes[r.error.code]);
      return;
    }
    close();
    router.push(`/knowledge/spaces/${r.value.id}`);
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      busy={busy}
      title={s.createTitle(parent.name)}
      description={s.createBody}
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void create();
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="section-name">{s.name}</Label>
          <div className="flex items-center gap-2.5">
            <SpaceGlyph icon={look.icon} color={look.color} size="lg" />
            <Input
              id="section-name"
              autoFocus
              required
              value={name}
              maxLength={120}
              placeholder={s.namePlaceholder}
              onChange={(e) => {
                setName(e.target.value);
                const suggested = !lookTouched && suggestAppearance(e.target.value);
                if (suggested) setLook(suggested);
              }}
              className="h-11 text-[15px]"
            />
          </div>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-xs font-medium text-muted">{s.purposeQuestion}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {SECTION_PURPOSES.map((p) => (
              <label
                key={p}
                className={cn(
                  "flex cursor-pointer flex-col gap-0.5 rounded-xl border px-3 py-2.5 transition-colors",
                  purpose === p
                    ? "border-accent-line bg-accent-soft"
                    : "border-border hover:border-border-strong",
                )}
              >
                <span className="flex items-center gap-2 text-[14px]">
                  <input
                    type="radio"
                    name="section-purpose"
                    value={p}
                    checked={purpose === p}
                    onChange={() => setPurpose(p)}
                    className="size-3.5 accent-[var(--color-accent)]"
                  />
                  {s.purposes[p]}
                </span>
                <span className="pl-5.5 text-[12.5px] text-muted">{s.purposeHints[p]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">{t.knowledge.appearance}</span>
          <AppearancePicker
            icon={look.icon}
            color={look.color}
            onChange={(next) => {
              setLook(next);
              setLookTouched(true);
            }}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="section-description">
            {t.knowledge.description}{" "}
            <span className="font-normal text-faint">· {t.knowledge.optional}</span>
          </Label>
          <textarea
            id="section-description"
            rows={2}
            value={description}
            maxLength={1000}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-16 w-full resize-none rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg transition-colors hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none"
          />
        </div>

        {error && (
          <p role="alert" className="text-[13.5px] text-danger-text">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t.knowledge.cancel}
          </Button>
          <Button type="submit" disabled={!name.trim() || busy}>
            {s.create}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
