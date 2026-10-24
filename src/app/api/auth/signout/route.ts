import { NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function POST(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/signin", req.nextUrl.origin));
  const supa = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(all: { name: string; value: string; options: CookieOptions }[]) {
          for (const { name, value, options } of all) {
            res.cookies.set(name, value, options);
          }
        },
      },
    }
  );
  await supa.auth.signOut();
  return res;
}
