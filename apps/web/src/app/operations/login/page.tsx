import type { Metadata } from "next";

import { OperatorLoginForm } from "./operator-login-form";

export const metadata: Metadata = {
  title: "Operator sign in",
  robots: { index: false, follow: false }
};

export default function OperatorLoginPage() {
  return (
    <main className="page-shell operator-login-page">
      <div>
        <h1>Operator sign in</h1>
        <p>
          Enter the bot API key to open a short-lived operator session in this
          browser.
        </p>
      </div>
      <OperatorLoginForm />
    </main>
  );
}
