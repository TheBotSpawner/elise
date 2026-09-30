"use client";

import { Paperclip } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/client";

import { createSpaceAction, listSpacesAction } from "./actions";
import { UPLOAD_ACCEPT } from "./constants";
import { uploadFiles } from "./upload";

const NEW = "__new";

/**
 * Attach from the composer. A chat file is never kept silently: the user chooses. Adding it to a
 * Knowledge Space works today; "only in this conversation" needs per-conversation files, which
 * don't exist yet, so it is shown as coming.
 */
export function AttachToKnowledge() {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [spaces, setSpaces] = useState<{ id: string; path: string }[] | null>(null);
  const [target, setTarget] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function choose(list: File[]) {
    setFiles(list);
    setSpaces(null);
    setNewName("");
    const r = await listSpacesAction();
    const found = r.ok ? r.value : [];
    setSpaces(found);
    setTarget(found[0]?.id ?? NEW);
  }

  async function add() {
    setBusy(true);
    let spaceId = target;
    if (target === NEW) {
      const created = await createSpaceAction(newName, null);
      if (!created.ok) {
        setBusy(false);
        toast.error(t.errors.codes[created.error.code]);
        return;
      }
      spaceId = created.value;
    }
    const r = await uploadFiles(spaceId, files);
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error.message || t.errors.codes[r.error.code]);
      return;
    }
    toast.success(t.knowledge.uploaded(r.value));
    setFiles([]);
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const list = [...(e.target.files ?? [])];
          e.target.value = "";
          if (list.length) void choose(list);
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        aria-label={t.knowledge.attach.button}
        title={t.knowledge.attach.button}
        className="grid size-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-active hover:text-fg"
      >
        <Paperclip className="size-[18px]" aria-hidden />
      </button>
      {/* Portaled: the composer is itself a <form>, and forms can't nest. */}
      {files.length > 0 &&
        createPortal(
          <Dialog
            open
            onClose={() => setFiles([])}
            busy={busy}
            title={t.knowledge.attach.title}
            description={files.map((f) => f.name).join(", ")}
          >
            <div className="flex items-center justify-between gap-3 rounded-2xl bg-surface-2 px-4 py-3 opacity-60">
              <span className="text-[14.5px]">{t.knowledge.attach.onlyHere}</span>
              <span className="type-status text-faint">{t.knowledge.attach.onlyHereSoon}</span>
            </div>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                // React events bubble through portals; keep this from sending the chat message.
                e.stopPropagation();
                void add();
              }}
            >
              <div className="flex flex-col gap-0.5">
                <p className="text-[15px] font-medium">{t.knowledge.attach.toKnowledge}</p>
                <p className="text-[13px] text-muted">{t.knowledge.attach.toKnowledgeBody}</p>
              </div>
              {spaces === null ? (
                <p className="text-[13px] text-faint">{t.common.loading}</p>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="attach-space">{t.knowledge.attach.chooseSpace}</Label>
                    <Select
                      id="attach-space"
                      data-autofocus=""
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    >
                      {spaces.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.path}
                        </option>
                      ))}
                      <option value={NEW}>{t.knowledge.attach.newSpace}</option>
                    </Select>
                  </div>
                  {target === NEW && (
                    <Input
                      aria-label={t.knowledge.spaceName}
                      placeholder={t.knowledge.spacePlaceholder}
                      value={newName}
                      maxLength={120}
                      required
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  )}
                </>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setFiles([])} disabled={busy}>
                  {t.knowledge.cancel}
                </Button>
                <Button
                  type="submit"
                  disabled={busy || spaces === null || (target === NEW && !newName.trim())}
                >
                  {busy ? t.knowledge.uploading : t.knowledge.attach.add}
                </Button>
              </div>
            </form>
          </Dialog>,
          document.body,
        )}
    </>
  );
}
