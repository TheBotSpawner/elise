import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getAuthContext } from "@/application/auth-context";
import { connectRequestSchema } from "@/application/desktop-service";
import { Orb } from "@/components/elise/orb/orb";
import { ConnectDesktop } from "@/features/desktop/connect-desktop";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "ELISE Desktop" };

/**
 * ELISE Desktop signs in here, in the system browser (ADR-081): whatever sign-in method the
 * person uses on the web, then one explicit "Conectar". Malformed requests never get a code.
 */
export default async function DesktopConnectPage({ searchParams }: PageProps<"/desktop/connect">) {
  const [params, auth, { t }] = await Promise.all([searchParams, getAuthContext(), getT()]);
  const request = connectRequestSchema.safeParse({
    challenge: params.challenge,
    state: params.state,
    installation: params.installation,
  });
  if (request.success && !auth) {
    const back = `/desktop/connect?${new URLSearchParams(request.data as Record<string, string>)}`;
    redirect(`/login?next=${encodeURIComponent(back)}`);
  }
  return (
    <main className="elise-halo flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12">
      <Orb size={160} />
      {request.success && auth ? (
        <ConnectDesktop request={request.data} email={auth.email} />
      ) : (
        <p role="alert" className="max-w-sm text-center text-[14.5px] text-muted">
          {t.desktop.connect.invalid}
        </p>
      )}
    </main>
  );
}
