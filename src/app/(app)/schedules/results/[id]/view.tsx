"use client";

import { PageContainer } from "@/components/shared/page";
import { BriefView } from "@/features/schedules/brief-view";

import type { ResultProps } from "./load";

export function View(props: ResultProps) {
  return (
    <PageContainer>
      <div className="mx-auto max-w-[680px]">
        <BriefView {...props} />
      </div>
    </PageContainer>
  );
}
