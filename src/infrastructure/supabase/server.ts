import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { supabasePublicConfig } from "@/config/env";

import type { Database } from "./database.types";

export type ServerSupabase = SupabaseClient<Database>;

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * Acts as the signed-in user (publishable key + session cookies), so RLS applies.
 */
export async function createClient(): Promise<ServerSupabase> {
  const cookieStore = await cookies();
  const { url, publishableKey } = supabasePublicConfig();

  return createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot set cookies; src/proxy.ts refreshes the session instead.
        }
      },
    },
  });
}
