"use client";

import { OnboardingFlow } from "@/features/onboarding/onboarding-flow";

import type { OnboardingProps } from "./load";

export function View(props: OnboardingProps) {
  return (
    <main className="elise-halo flex min-h-dvh items-center justify-center px-4 py-12">
      <OnboardingFlow {...props} />
    </main>
  );
}
