import "server-only";

import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/infrastructure/supabase/server";

const OTP_TYPES: readonly EmailOtpType[] = [
  "signup",
  "magiclink",
  "recovery",
  "invite",
  "email_change",
  "email",
];

/**
 * Completes Supabase Auth redirects: OAuth/PKCE (`code`) or email links (`token_hash` + `type`).
 * Returns an error code instead of throwing so the route can redirect gracefully.
 */
export async function completeAuthRedirect(
  params: URLSearchParams,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const supabase = await createClient();
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type");

  let error: { code?: string } | null;
  if (code) {
    ({ error } = await supabase.auth.exchangeCodeForSession(code));
  } else if (tokenHash && type && (OTP_TYPES as readonly string[]).includes(type)) {
    ({ error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    }));
  } else {
    return { ok: false, code: "missing_params" };
  }
  return error ? { ok: false, code: error.code ?? "unknown" } : { ok: true };
}
