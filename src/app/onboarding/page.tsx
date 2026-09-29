import { redirect } from "next/navigation";

import { getAuthContext } from "@/application/auth-context";
import { OnboardingFlow } from "@/features/onboarding/onboarding-flow";

export default async function OnboardingPage() {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  if (auth.profile.onboardingStatus !== "pending") redirect("/");
  return (
    <main className="elise-backdrop flex min-h-dvh items-center justify-center px-4 py-12">
      <OnboardingFlow />
    </main>
  );
}
