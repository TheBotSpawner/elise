"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import {
  DEFAULT_SPACE_COLOR,
  DEFAULT_SPACE_ICON,
  suggestAppearance,
  type SpaceColor,
  type SpaceIcon,
} from "@/core/knowledge/appearance";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { createSectionAction } from "./actions";
import { AppearancePicker, SpaceGlyph } from "./appearance";

/**
 * "+ New section" (ADR-018/020): a name, a look and an optional description. A Section is a
 * part of its Space, not a category: Study, Work Intelligence and Meeting Prep come from what
 * the user asks, never from a type chosen here.
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
    });
    setBusy(false);
    if (!r.ok) {
      setError(errorText(t, r.error));
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
