// Dark-phase sign-in. KF mark + one sentence. No product name, no tool
// names, no identity band. The HTML must contain nothing that explains what
// this app is or who it serves.

import { SignInButton } from "./signin-button";
import "./signin.css";

export const metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return (
    <main className="kf-signin">
      <div className="kf-signin__card">
        <div className="kf-signin__mark" aria-label="KF">
          <span className="kf-signin__mark-k">K</span>
          <span className="kf-signin__mark-dot" />
          <span className="kf-signin__mark-f">F</span>
        </div>
        <SignInButton />
        <p className="kf-signin__hint">Sign in with your kitchfix.com Google account</p>
      </div>
    </main>
  );
}
