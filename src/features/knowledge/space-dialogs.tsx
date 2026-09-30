"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { KnowledgeAccount } from "@/application/knowledge-service";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/client";

import { createSpaceAction } from "./actions";
import { MAX_UPLOAD_MB, UPLOAD_ACCEPT } from "./constants";
import { DrivePicker, NotionPicker } from "./source-pickers";
import { SourceOptions, type SourceChoice } from "./ui";
import { uploadFiles } from "./upload";

const textareaClass =
  "min-h-20 w-full resize-none rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg placeholder:text-muted/70 transition-colors hover:border-border-strong focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft";

/**
 * Create a Space in two steps: what it is, then (optionally) what goes in it. Nothing is created
 * until step 2, so closing the dialog at any point leaves no trace. Drive and Notion continue on
 * the new Space's page, where the account pickers live.
 */
export function CreateSpaceDialog({
  open,
  onClose,
  parent = null,
  initialName = "",
  notionAvailable,
}: {
  open: boolean;
  onClose: () => void;
  parent?: { id: string; name: string } | null;
  initialName?: string;
  notionAvailable: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);

  // Opening with a suggested name ("Work") starts from it; closing forgets the draft.
  const [openedWith, setOpenedWith] = useState<string | null>(null);
  if (open && openedWith === null) {
    setOpenedWith(initialName);
    setName(initialName);
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
    const created = await createSpaceAction(name, parent?.id ?? null, description.trim() || null);
    if (!created.ok) {
      setBusy(false);
      setError(t.errors.codes[created.error.code]);
      return;
    }
    if (files?.length) {
      const r = await uploadFiles(created.value, files);
      if (!r.ok) toast.error(r.error.message || t.errors.codes[r.error.code]);
      else toast.success(t.knowledge.uploaded(r.value));
    }
    const add = choice === "drive" ? "?add=drive" : choice === "notion" ? "?add=notion" : "";
    router.push(`/knowledge/spaces/${created.value}${add}`);
    setBusy(false);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={busy}
      title={
        step === 1
          ? parent
            ? t.knowledge.subspaceTitle(parent.name)
            : t.knowledge.createTitle
          : t.knowledge.addTitle
      }
      description={step === 1 ? t.knowledge.createBody : t.knowledge.addBody}
    >
      <div ref={body} className="flex flex-col gap-5">
        {step === 1 ? (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) setStep(2);
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="space-name">{t.knowledge.spaceName}</Label>
              <Input
                id="space-name"
                data-autofocus=""
                required
                value={name}
                maxLength={120}
                placeholder={t.knowledge.spacePlaceholder}
                onChange={(e) => setName(e.target.value)}
                className="h-11 text-[15px]"
              />
              <ul className="flex flex-wrap gap-1.5" aria-label={t.knowledge.spacePlaceholder}>
                {t.knowledge.nameExamples.map((example) => (
                  <li key={example}>
                    <button
                      type="button"
                      onClick={() => setName(example)}
                      className="h-8 rounded-full bg-surface-2 px-3 text-[13px] text-muted transition-colors hover:text-fg"
                    >
                      {example}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
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
            <p className="text-[13px] text-faint">{t.knowledge.helper}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t.knowledge.cancel}
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                {t.knowledge.continue}
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
  accounts,
  notionAvailable,
}: {
  view: AddSourceView | null;
  onView: (view: AddSourceView) => void;
  onClose: () => void;
  /** Opens the page's file chooser (uploads show their progress on the page). */
  onUpload: () => void;
  spaceId: string;
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
