"use client";
import Link from "next/link";
import { useAccountSession } from "../../lib/use-account-session";

const actions = {
  keys: {
    href: "/settings",
    title: "Key settings",
    description: "Store the API keys used to research applicants."
  },
  password: {
    href: "/account/change-password",
    title: "Change password",
    description: "Replace the password you sign in with."
  },
  email: {
    href: "/account/email",
    title: "Change email",
    description: "Move your account to a new email address."
  }
} as const;

export function AccountOverview() {
  const account = useAccountSession();
  const order: (keyof typeof actions)[] = account?.passwordChangeRequired
    ? ["password", "keys", "email"]
    : ["keys", "password", "email"];
  return (
    <main className="page-shell operator-login-page account-page">
      <div>
        <h1>Account</h1>
        <p>Manage how you sign in and the keys SlashWho uses for you.</p>
      </div>
      {account === undefined ? (
        <p className="account-page-status" role="status">
          Checking your session…
        </p>
      ) : account === null ? (
        <div className="operator-login-form account-signed-out">
          <p>You are not signed in.</p>
          <p className="account-form-links">
            <Link href="/operations/login">Sign in</Link> ·{" "}
            <Link href="/account/create">Create account</Link>
          </p>
        </div>
      ) : (
        <>
          <section
            className="operator-login-form account-identity"
            aria-labelledby="account-identity-label"
          >
            <span id="account-identity-label" className="account-label">
              Signed in as
            </span>
            <span className="account-email">{account.email}</span>
            {account.passwordChangeRequired && (
              <p className="account-notice" role="status">
                Change your password to continue using your account.
              </p>
            )}
          </section>
          <nav aria-label="Account settings">
            <ul className="account-actions">
              {order.map((key) => (
                <li key={key}>
                  <Link className="account-action" href={actions[key].href}>
                    <span className="account-action-title">
                      {actions[key].title}
                    </span>
                    <span className="account-action-description">
                      {actions[key].description}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </>
      )}
    </main>
  );
}
