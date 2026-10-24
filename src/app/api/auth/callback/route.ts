// Google OAuth callback. Supabase sets its session cookies here. Always
// redirects back to the originally-requested path (?from=...) or Home.

import { NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.clone();
  const code = url.searchParams.get("code");
  const from = url.searchParams.get("from") || url.searchParams.get("next") || "/";
  const dest = from.startsWith("/") ? from : "/";

  if (!code) {
    url.pathname = "/signin";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const res = NextResponse.redirect(new URL(dest, req.nextUrl.origin));

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

  const { error } = await supa.auth.exchangeCodeForSession(code);
  if (error) {
    const back = new URL("/signin", req.nextUrl.origin);
    back.searchParams.set("err", error.message.slice(0, 120));
    return NextResponse.redirect(back);
  }

  return res;
}
