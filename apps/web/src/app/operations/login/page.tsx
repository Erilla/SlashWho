import type { Metadata } from "next";

import { OperatorLoginForm } from "./operator-login-form";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false }
};

export default function OperatorLoginPage() {
  return (
    <main className="page-shell operator-login-page">
      <div>
        <h1>Sign in</h1>
        <p>Enter your verified email address and password.</p>
      </div>
      <OperatorLoginForm />
    </main>
  );
}
