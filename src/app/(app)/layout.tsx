import { redirect } from "next/navigation";

import { listPendingApprovals } from "@/application/approvals-service";
import { getAuthContext } from "@/application/auth-context";
import { visibleModules } from "@/application/modules-service";
import { AppShell } from "@/components/elise/app-shell";
import { DocumentViewerProvider } from "@/features/knowledge/document-viewer";
import { ResultNotifier } from "@/features/schedules/browser-notifications";
import { AlarmController } from "@/features/time/alarm-controller";
import { TimeController } from "@/features/time/time-view";
import { QuickVoice } from "@/features/voice/quick-voice";

/** Authenticated area. The proxy redirects optimistically; this is the authoritative check. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  if (auth.profile.onboardingStatus === "pending") redirect("/onboarding");

  const [pending, modules] = await Promise.all([listPendingApprovals(auth), visibleModules(auth)]);
  const name = auth.profile.displayName || auth.email?.split("@")[0] || "ELISE";
  return (
    <AppShell
      workspaceId={auth.workspaceId}
      pendingApprovals={pending.length}
      modules={modules}
      user={{ name, initial: name.charAt(0).toUpperCase(), email: auth.email }}
    >
      <DocumentViewerProvider>
        <ResultNotifier userId={auth.userId} />
        {/* Native Time (ADR-045): timers belong to the user, so they live on every page. */}
        <TimeController workspaceId={auth.workspaceId} userId={auth.userId} />
        <AlarmController workspaceId={auth.workspaceId} />
        {children}
        {/* Voice from any page but Inicio: a small Orb in the corner, audio only. */}
        <QuickVoice prefs={auth.profile.voice} />
      </DocumentViewerProvider>
    </AppShell>
  );
}
