"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  accountSessionChangedEvent,
  notifyAccountSessionChanged
} from "../lib/account-session-events";

type Account = {
  email: string;
  role: "user" | "admin";
  passwordChangeRequired: boolean;
};

export function AccountNavigation() {
  const [account, setAccount] = useState<Account | null>(null);
  const [signOutError, setSignOutError] = useState("");
  useEffect(() => {
    let current = true;
    let generation = 0;
    function refresh() {
      const requestGeneration = ++generation;
      fetch("/api/account/session", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { account?: Account } | null) => {
          if (current && requestGeneration === generation)
            setAccount(data?.account ?? null);
        })
        .catch(() => {
          if (current && requestGeneration === generation) setAccount(null);
        });
    }
    refresh();
    window.addEventListener(accountSessionChangedEvent, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      current = false;
      window.removeEventListener(accountSessionChangedEvent, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  async function signOut() {
    setSignOutError("");
    try {
      const response = await fetch("/api/operations/session/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      if (!response.ok) throw new Error("sign_out_failed");
    } catch {
      setSignOutError("Sign out failed. Please try again.");
      return;
    }
    setAccount(null);
    notifyAccountSessionChanged();
    window.location.assign("/");
  }
  if (!account)
    return (
      <>
        <Link href="/operations/login" className="site-nav-link">
          Sign in
        </Link>
        <Link href="/account/create" className="site-nav-link">
          Create account
        </Link>
      </>
    );
  return (
    <div className="account-navigation">
      <span>{account.email}</span>
      <Link href="/account">Account</Link>
      {!account.passwordChangeRequired && (
        <Link href="/settings">Key settings</Link>
      )}
      <Link href="/account/change-password">Change password</Link>
      {!account.passwordChangeRequired && (
        <Link href="/account/email">Change email</Link>
      )}
      {account.role === "admin" && !account.passwordChangeRequired && (
        <>
          <Link href="/admin/settings">Admin settings</Link>
          <Link href="/operations/collection-monitor">Collection monitor</Link>
        </>
      )}
      <button type="button" onClick={signOut}>
        Sign out
      </button>
      {signOutError && <p role="alert">{signOutError}</p>}
    </div>
  );
}
