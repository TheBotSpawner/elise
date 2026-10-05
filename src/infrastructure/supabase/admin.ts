import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { supabasePublicConfig } from "@/config/env";
import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";

import type { Database } from "./database.types";

let admin: SupabaseClient<Database> | undefined;

/**
 * Privileged client (secret key: bypasses RLS). Only for operations the user's session must
 * not perform directly — reading/writing encrypted credentials and creating provider
 * connections after a verified OAuth callback. Every call site scopes by workspace_id
 * explicitly (docs/engineering/17 §11). Never import from client code.
 */
export function createAdminClient(): SupabaseClient<Database> {
  if (admin) return admin;
  const secret = serverEnv().SUPABASE_SECRET_KEY;
  if (!secret) {
    throw new AppError("SERVER_NOT_CONFIGURED", "SUPABASE_SECRET_KEY is not configured", {
      recovery: "configure",
    });
  }
  admin = createClient<Database>(supabasePublicConfig().url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}
