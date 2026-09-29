import type { NextRequest } from "next/server";

import { updateSession } from "@/infrastructure/supabase/proxy";

export async function proxy(request: NextRequest) {
  // Propagate a request ID so logs, AI runs and errors of one request can be correlated.
  const headers = new Headers(request.headers);
  if (!headers.has("x-request-id")) headers.set("x-request-id", crypto.randomUUID());
  return updateSession(request, headers);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
