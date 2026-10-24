"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useState } from "react";

export function SignInButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const click = async () => {
    setBusy(true);
    setErr(null);
    try {
      const supa = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      );
      const { error } = await supa.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${window.location.origin}/api/auth/callback`,
          queryParams: { hd: "kitchfix.com", prompt: "select_account" },
        },
      });
      if (error) setErr(error.message);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="kf-signin__btn" onClick={click} disabled={busy}>
        {busy ? "Signing in..." : "Continue with Google"}
      </button>
      {err ? <p className="kf-signin__err" role="alert">{err}</p> : null}
    </>
  );
}
