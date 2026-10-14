import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/application/auth-context";
import { microsoftDiagnostics } from "@/infrastructure/providers/microsoft/config";

/**
 * Microsoft OAuth readiness for this server, for the workspace owner only (ADR-058). Booleans and
 * safe metadata — never a secret, token or tenant id. Also checks that the database knows the
 * "microsoft" provider (migration 045), the other thing Connect needs.
 */
export async function GET(request: NextRequest) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "AUTH_ERROR" }, { status: 401 });
  const { data: workspace } = await auth.db
    .from("workspaces")
    .select("owner_user_id")
    .eq("id", auth.workspaceId)
    .maybeSingle();
  if (workspace?.owner_user_id !== auth.userId)
    return NextResponse.json({ error: "PERMISSION_DENIED" }, { status: 403 });
  const { data: provider } = await auth.db
    .from("provider_definitions")
    .select("key")
    .eq("key", "microsoft")
    .maybeSingle();
  const diagnostics = microsoftDiagnostics(request.nextUrl.origin);
  return NextResponse.json(
    {
      ...diagnostics,
      database: { providerRegistered: Boolean(provider) },
      ready: diagnostics.ready && Boolean(provider),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
