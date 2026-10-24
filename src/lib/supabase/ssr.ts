import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requiredEnv } from "./env";

export async function sessionClient() {
  const store = await cookies();
  return createServerClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return store.getAll();
        },
        setAll(all: { name: string; value: string; options: CookieOptions }[]) {
          try {
            for (const { name, value, options } of all) {
              store.set(name, value, options);
            }
          } catch {
            // No-op when called from a server component; the middleware refresh
            // handles cookie writes for the request lifecycle.
          }
        },
      },
    }
  );
}

export async function sessionEmail(): Promise<string | null> {
  const supa = await sessionClient();
  const { data } = await supa.auth.getUser();
  const email = data.user?.email;
  return email ? email.toLowerCase() : null;
}
