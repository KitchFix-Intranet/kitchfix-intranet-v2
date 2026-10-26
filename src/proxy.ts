// Proxy (Next 16 - formerly middleware.ts). Two jobs:
//   1. Refresh the Supabase session cookie on every request so the SSR client
//      hands server components a current access token.
//   2. If a page request has no session, redirect to /signin; if an API
//      request has no session, return 401.
//
// The owner-email check (OWNER_EMAILS gate) does NOT live here - it lives in
// src/lib/gate.ts and is called from every protected server component / route
// handler. That lets us use Next's notFound() to render the plain app/not-found
// page without any proxy-rewrite gymnastics.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

const SIGNIN_PATH = "/signin";
const CALLBACK_PATH = "/api/auth/callback";

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function isPublic(pathname: string): boolean {
  if (pathname === SIGNIN_PATH) return true;
  if (pathname === CALLBACK_PATH) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico") return true;
  return false;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  // Mirror the pathname onto a request header so server components can read
  // it (Next does not expose `pathname` through `headers()` by default).
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", pathname);
  const res = NextResponse.next({ request: { headers: requestHeaders } });

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

  const { data } = await supa.auth.getUser();
  const email = data.user?.email?.toLowerCase() ?? null;

  if (!email) {
    if (isApiRoute(pathname)) {
      // API routes may authenticate with a cron secret instead of a session.
      // The proxy cannot see the secret safely (constant-time compare lives
      // in the gate helper), so if the header is present we let the request
      // reach its handler and let the handler decide.
      if (req.headers.get("x-cron-secret")) return res;
      return new NextResponse(null, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = SIGNIN_PATH;
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|jpg|jpeg|svg|ico|webp|woff2)$).*)"],
};
