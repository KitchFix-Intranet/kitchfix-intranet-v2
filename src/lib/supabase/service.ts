import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { requiredEnv } from "./env";

let cached: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  return cached;
}
