"use client";

import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { useI18n } from "@/lib/i18n/client";

import { deleteConversationAction } from "./actions";

export function DeleteConversationButton({ id, title }: { id: string; title: string }) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      aria-label={t.chat.deleteConversation}
      title={t.chat.deleteConversation}
      disabled={pending}
      onClick={() => {
        if (!window.confirm(t.chat.deleteConfirm(title))) return;
        startTransition(async () => {
          const result = await deleteConversationAction(id);
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
