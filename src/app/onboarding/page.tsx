import { redirect } from "next/navigation";

import { getAuthContext } from "@/application/auth-context";
import { listConnections } from "@/application/connections-service";
import { listSpaces } from "@/application/knowledge-service";
import {
  ONBOARDING_STEPS,
  SPACE_PRESETS,
  type OnboardingProgress,
} from "@/features/onboarding/model";
import { OnboardingFlow } from "@/features/onboarding/onboarding-flow";

/**
 * First run (ADR-019). New accounts land here once; anyone can see it again from Settings
 * (`?again=1`). Progress is saved per step, so returning from Google or Notion resumes it.
 */
export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  const [auth, params] = await Promise.all([getAuthContext(), searchParams]);
  if (!auth) redirect("/login");
  const again = params.again === "1";
  if (auth.profile.onboardingStatus !== "pending" && !again && !params.connected && !params.error)
    redirect("/");

  const [progressRow, connections, spaces] = await Promise.all([
    auth.db
      .from("user_preferences")
      .select("value_json")
      .eq("workspace_id", auth.workspaceId)
      .eq("user_id", auth.userId)
      .eq("key", "onboarding.progress")
      .maybeSingle(),
    listConnections(auth).catch(() => null),
    listSpaces(auth).catch(() => []),
  ]);
  const stored = (progressRow.data?.value_json ?? null) as Partial<OnboardingProgress> | null;
  const progress: OnboardingProgress = {
    step:
      params.connected || params.error
        ? "connect"
        : !again && ONBOARDING_STEPS.includes(stored?.step as never)
          ? stored!.step!
          : "welcome",
    spacePreset: SPACE_PRESETS.includes(stored?.spacePreset as never) ? stored!.spacePreset : null,
    spaceId: typeof stored?.spaceId === "string" ? stored.spaceId : null,
  };

  const accounts = (connections?.connections ?? [])
    .filter((c) => c.providerKey !== "elise_native")
    .map((c) => ({
      id: c.id,
      provider: c.providerKey as "google" | "notion",
      label: c.accountLabel ?? c.displayName,
      health: c.health,
      capabilities: c.capabilities.filter((x) => x.enabled && x.granted).map((x) => x.key),
    }));

  return (
    <main className="elise-halo flex min-h-dvh items-center justify-center px-4 py-12">
      <OnboardingFlow
        initial={progress}
        profile={{
          displayName: auth.profile.displayName ?? "",
          language: auth.profile.locale,
          timezone: auth.profile.timezone,
        }}
        accounts={accounts}
        googleAvailable={connections?.googleAvailable ?? false}
        notionAvailable={connections?.notionAvailable ?? false}
        spaces={spaces
          .filter((s) => !s.parentId)
          .map((s) => ({ id: s.id, name: s.name, icon: s.icon, color: s.color }))}
        returned={{
          connected: typeof params.connected === "string",
          missing: typeof params.missing === "string" ? params.missing.split(",") : [],
          error: typeof params.error === "string" ? params.error : null,
        }}
      />
    </main>
  );
}
