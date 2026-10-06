import { redirect } from "next/navigation";

import { listPendingApprovals } from "@/application/approvals-service";
import { getAuthContext } from "@/application/auth-context";
import { AppShell } from "@/components/elise/app-shell";
import { ResultNotifier } from "@/features/schedules/browser-notifications";
import { TimeController } from "@/features/time/time-view";

/** Authenticated area. The proxy redirects optimistically; this is the authoritative check. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  if (auth.profile.onboardingStatus === "pending") redirect("/onboarding");

  const pending = await listPendingApprovals(auth);
  const name = auth.profile.displayName || auth.email?.split("@")[0] || "ELISE";
  return (
    <AppShell
      workspaceId={auth.workspaceId}
      pendingApprovals={pending.length}
      user={{ name, initial: name.charAt(0).toUpperCase(), email: auth.email }}
    >
      <ResultNotifier userId={auth.userId} />
      {/* Native Time (ADR-045): timers belong to the user, so they live on every page. */}
      <TimeController workspaceId={auth.workspaceId} userId={auth.userId} />
      {children}
    </AppShell>
  );
}
