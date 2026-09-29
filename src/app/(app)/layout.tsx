import { redirect } from "next/navigation";

import { listPendingApprovals } from "@/application/approvals-service";
import { getAuthContext } from "@/application/auth-context";
import { AppShell } from "@/components/elise/app-shell";

/** Authenticated area. The proxy redirects optimistically; this is the authoritative check. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");
  if (auth.profile.onboardingStatus === "pending") redirect("/onboarding");

  const pending = await listPendingApprovals(auth);
  return (
    <AppShell workspaceId={auth.workspaceId} pendingApprovals={pending.length}>
      {children}
    </AppShell>
  );
}
