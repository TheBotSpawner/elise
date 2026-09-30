"use client";

import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { useI18n } from "@/lib/i18n/client";

import { deleteConversationAction, deleteVoiceSessionAction } from "./actions";

export function DeleteConversationButton({
  id,
  title,
  voice = false,
}: {
  id: string;
  title: string;
  /** A voice session (no History thread of its own). */
  voice?: boolean;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      aria-label={t.chat.deleteConversation}
      title={t.chat.deleteConversation}
      disabled={pending}
      onClick={() => {
        if (!window.confirm(voice ? t.voice.deleteConfirm(title) : t.chat.deleteConfirm(title)))
          return;
        startTransition(async () => {
          const result = voice
            ? await deleteVoiceSessionAction(id)
            : await deleteConversationAction(id);
          if (result.ok) toast.success(t.chat.deleted);
          else toast.error(t.errors.codes[result.error.code]);
        });
      }}
      className="hover:text-error grid size-8 shrink-0 place-items-center rounded-full text-faint transition-colors disabled:opacity-50"
    >
      <Trash2 className="size-4" aria-hidden />
    </button>
  );
}
