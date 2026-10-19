"use client";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageHeader } from "@/components/shared/page";
import { ListsWorkspace } from "@/features/native/lists-workspace";
import { useI18n } from "@/lib/i18n/client";

import type { ListsProps } from "./load";

export function View({ lists, workspaceId, focus }: ListsProps) {
  const { t } = useI18n();
  return (
    // Wide: lists sit side by side as columns (ADR-051).
    <div className="mx-auto w-full max-w-[1800px] px-4 pt-6 pb-10 md:px-10 md:pt-10">
      <PageHeader
        title={t.native.lists.title}
        icon={MY_ELISE_ICONS.lists}
        info={[t.native.lists.subtitle]}
      />
      <ListsWorkspace lists={lists} workspaceId={workspaceId} focus={focus} />
    </div>
  );
}
