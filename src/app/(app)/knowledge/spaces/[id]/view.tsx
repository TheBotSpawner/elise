"use client";

import { PageContainer } from "@/components/shared/page";
import { SpaceView } from "@/features/knowledge/space-view";
import { MethodsPanel } from "@/features/methods/methods-panel";

import type { SpaceProps } from "./load";

export function View({ methods, methodSpaces, here, ...props }: SpaceProps) {
  return (
    <PageContainer>
      <SpaceView
        {...props}
        methods={here && <MethodsPanel methods={methods} spaces={methodSpaces} space={here} />}
      />
    </PageContainer>
  );
}
