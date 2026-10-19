"use client";

import { PageContainer } from "@/components/shared/page";
import { ContextEditor } from "@/features/contexts/contexts-view";

import type { ContextProps } from "./load";

export function View({ profile, catalog, progress }: ContextProps) {
  return (
    <PageContainer>
      <ContextEditor profile={profile} catalog={catalog} progress={progress} />
    </PageContainer>
  );
}
