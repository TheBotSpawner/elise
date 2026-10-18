import { createClient as create, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/infrastructure/supabase/database.types";

let client: SupabaseClient<Database> | undefined;

/**
 * Supabase in Desktop's renderer (ADR-081): Realtime and uploads as the signed-in person, with
 * a short-lived access token from the main process. The refresh token never reaches here.
 */
export function createClient(): SupabaseClient<Database> {
  client ??= create<Database>(__ELISE_BUILD__.supabaseUrl, __ELISE_BUILD__.supabasePublishableKey, {
    accessToken: async () => (await window.eliseDesktop?.getAccessToken()) ?? null,
  });
  return client;
}
