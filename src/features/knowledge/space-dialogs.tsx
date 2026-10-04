"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { KnowledgeAccount, SpaceSummary } from "@/application/knowledge-service";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import {
  DEFAULT_SPACE_COLOR,
  DEFAULT_SPACE_ICON,
  suggestAppearance,
  type SpaceColor,
  type SpaceIcon,
} from "@/core/knowledge/appearance";
import { withDescendants } from "@/core/knowledge/model";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { createSpaceAction, moveSpaceAction, updateSpaceAction } from "./actions";
import { AppearancePicker, SpaceGlyph } from "./appearance";
import { MAX_UPLOAD_MB, UPLOAD_ACCEPT } from "./constants";
import { DrivePicker, NotionPicker } from "./source-pickers";
import { SourceOptions, type SourceChoice } from "./ui";
import { uploadFiles } from "./upload";

const textareaClass =
  "min-h-20 w-full resize-none rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg placeholder:text-muted/70 transition-colors hover:border-border-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft";

/**
 * Create a Space in two steps: what it is, then (optionally) what goes in it. Nothing is created
 * until step 2, so closing the dialog at any point leaves no trace. Drive and Notion continue on
 * the new Space's page, where the account pickers live. With `space` it edits that Space (one
 * step: name, description, icon, color and parent).
 */
export function CreateSpaceDialog({
  open,
  onClose,
  parent = null,
  initialName = "",
  notionAvailable,
  space = null,
  allSpaces = [],
}: {
  open: boolean;
  onClose: () => void;
  parent?: { id: string; name: string } | null;
  initialName?: string;
  notionAvailable: boolean;
  space?: SpaceSummary | null;
  allSpaces?: SpaceSummary[];
}) {
  const editing = Boolean(space);
  const { t } = useI18n();
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [look, setLook] = useState<{ icon: SpaceIcon; color: SpaceColor }>({
    icon: DEFAULT_SPACE_ICON,
    color: DEFAULT_SPACE_COLOR,
  });
  // Until the user picks a look, it follows the name ("University" -> graduation cap, blue).
  const [lookTouched, setLookTouched] = useState(false);
  const [parentId, setParentId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);

  // Opening with a suggested name ("Work") starts from it; closing forgets the draft.
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  if (open && openedWith === null) {
    setOpenedWith(initialName);
    setName(space?.name ?? initialName);
    setDescription(space?.description ?? "");
    setLook(
      space
        ? { icon: space.icon, color: space.color }
        : (suggestAppearance(initialName) ?? {
            icon: DEFAULT_SPACE_ICON,
            color: DEFAULT_SPACE_COLOR,
          }),
    );
    setLookTouched(Boolean(space));
    setParentId(space?.parentId ?? "");
  }
  if (!open && openedWith !== null) {
    setOpenedWith(null);
    setStep(1);
    setDescription("");
    setError(null);
  }

  useEffect(() => {
    body.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [step]);

  async function finish(choice: SourceChoice, files?: File[]) {
    setBusy(true);
    setError(null);
    const created = await createSpaceAction({
      name,
      parentId: parent?.id ?? null,
      description: description.trim() || null,
      ...look,
    });
    if (!created.ok) {
      setBusy(false);
      setError(t.errors.codes[created.error.code]);
      return;
    }
    if (files?.length) {
      const r = await uploadFiles(created.value, files);
      if (!r.ok) toast.error(errorText(t, r.error));
      else toast.success(t.knowledge.uploaded(r.value));
    }
    const add = choice === "drive" ? "?add=drive" : choice === "notion" ? "?add=notion" : "";
    router.push(`/knowledge/spaces/${created.value}${add}`);
    setBusy(false);
    onClose();
  }

  async function save() {
    if (!space) return;
    setBusy(true);
    setError(null);
    const r = await updateSpaceAction(space.id, {
      name,
      description: description.trim() || null,
      ...look,
    });
    const moved =
      r.ok && (parentId || null) !== space.parentId
        ? await moveSpaceAction(space.id, parentId || null)
        : r;
    setBusy(false);
    if (!moved.ok) {
      setError(t.errors.codes[moved.error.code]);
      return;
    }
    router.refresh();
    onClose();
  }

  const setNameAndLook = (value: string) => {
    setName(value);
    if (!lookTouched) {
      const suggested = suggestAppearance(value);
      if (suggested) setLook(suggested);
    }
  };
  // One visible level (ADR-018): a Space becomes a Section only under a top-level Space, and
  // only while it has no Sections of its own.
  const blocked = space ? new Set(withDescendants(allSpaces, [space.id])) : new Set<string>();
  const hasSections = space ? allSpaces.some((x) => x.parentId === space.id) : false;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      title={
        editing
          ? t.knowledge.editTitle
          : step === 1
            ? parent
              ? t.knowledge.subspaceTitle(parent.name)
              : t.knowledge.createTitle
            : t.knowledge.addTitle
      }
      description={editing ? undefined : step === 1 ? t.knowledge.createBody : t.knowledge.addBody}
    >
      <div ref={body} className="flex flex-col gap-5">
        {step === 1 ? (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              if (editing) void save();
              else setStep(2);
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="space-name">{t.knowledge.spaceName}</Label>
              <div className="flex items-center gap-2.5">
                <SpaceGlyph icon={look.icon} color={look.color} size="lg" />
                <Input
                  id="space-name"
                  data-autofocus=""
                  required
                  value={name}
                  maxLength={120}
                  placeholder={t.knowledge.spacePlaceholder}
                  onChange={(e) => setNameAndLook(e.target.value)}
                  className="h-11 text-[15px]"
                />
              </div>
              {!editing && (
                <ul className="flex flex-wrap gap-1.5" aria-label={t.knowledge.spacePlaceholder}>
                  {t.knowledge.nameExamples.map((example) => (
                    <li key={example}>
                      <button
                        type="button"
                        onClick={() => setNameAndLook(example)}
                        className="h-8 rounded-full bg-surface-2 px-3 text-[13px] text-muted transition-colors hover:text-fg"
                      >
                        {example}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
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
            {editing && !hasSections && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="space-parent">{t.knowledge.parent}</Label>
                <Select
                  id="space-parent"
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                >
                  <option value="">{t.knowledge.topLevel}</option>
                  {allSpaces
                    .filter((x) => !blocked.has(x.id) && !x.parentId)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.path}
                      </option>
                    ))}
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="space-description">
                {t.knowledge.description}{" "}
                <span className="font-normal text-faint">· {t.knowledge.optional}</span>
              </Label>
              <textarea
                id="space-description"
                rows={2}
                value={description}
                maxLength={1000}
                placeholder={t.knowledge.descriptionPlaceholder}
                onChange={(e) => setDescription(e.target.value)}
                className={textareaClass}
              />
            </div>
            {!editing && <p className="text-[13px] text-faint">{t.knowledge.helper}</p>}
            {editing && error && (
              <p role="alert" className="text-[13.5px] text-danger-text">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                {t.knowledge.cancel}
              </Button>
              <Button type="submit" disabled={!name.trim() || busy}>
                {editing ? t.knowledge.save : t.knowledge.continue}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={UPLOAD_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (files.length) void finish("upload", files);
              }}
            />
            <SourceOptions
              choices={["upload", "drive", "notion", "empty"]}
              unavailable={notionAvailable ? [] : ["notion"]}
              disabled={busy}
              onPick={(choice) =>
                choice === "upload" ? fileInput.current?.click() : void finish(choice)
              }
            />
            <p className="text-[12.5px] text-faint">{t.knowledge.uploadHint(MAX_UPLOAD_MB)}</p>
            {error && (
              <p role="alert" className="text-[13.5px] text-danger-text">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(1)} disabled={busy}>
                <ArrowLeft />
                {t.knowledge.back}
              </Button>
              <span aria-live="polite" className="text-[13px] text-muted">
                {busy ? t.knowledge.creating : ""}
              </span>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

export type AddSourceView = "choose" | "drive" | "notion";

/** "+ Add source" on a Space: documents, Google Drive or Notion, one at a time. */
export function AddSourceDialog({
  view,
  onView,
  onClose,
  onUpload,
  spaceId,
  destination,
  accounts,
  notionAvailable,
}: {
  view: AddSourceView | null;
  onView: (view: AddSourceView) => void;
  onClose: () => void;
  /** Opens the page's file chooser (uploads show their progress on the page). */
  onUpload: () => void;
  spaceId: string;
  /** "UTN › AMII": where the new source goes — this Section, never its parent Space. */
  destination: string;
  accounts: KnowledgeAccount[];
  notionAvailable: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const done = () => {
    onClose();
    router.refresh();
  };
  return (
    <Dialog
      open={view !== null}
      onClose={onClose}
      title={
        view === "drive"
          ? t.knowledge.picker.titleDrive
          : view === "notion"
            ? t.knowledge.picker.titleNotion
            : t.knowledge.addSource
      }
      description={view === "choose" ? t.knowledge.addBody : undefined}
    >
      <p className="-mt-1 mb-3 text-[13px] text-muted">{t.knowledge.addTo(destination)}</p>
      {view === "choose" && (
        <SourceOptions
          choices={["documents", "drive", "notion"]}
          unavailable={notionAvailable ? [] : ["notion"]}
          onPick={(choice) => {
            if (choice === "documents") {
              onUpload();
              onClose();
            } else onView(choice === "drive" ? "drive" : "notion");
          }}
        />
      )}
      {view === "drive" && <DrivePicker spaceId={spaceId} accounts={accounts} onDone={done} />}
      {view === "notion" && (
        <NotionPicker
          spaceId={spaceId}
          accounts={accounts}
          notionAvailable={notionAvailable}
          onDone={done}
        />
      )}
    </Dialog>
  );
}
