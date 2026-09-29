import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabasePublicConfig } from "@/config/env";

import type { Database } from "./database.types";

let browserClient: SupabaseClient<Database> | undefined;

/** Supabase client for Client Components (publishable key + user session; RLS applies). */
export function createClient(): SupabaseClient<Database> {
  if (!browserClient) {
    const { url, publishableKey } = supabasePublicConfig();
    browserClient = createBrowserClient<Database>(url, publishableKey);
  }
  return browserClient;
}
