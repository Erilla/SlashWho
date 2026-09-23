"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type Account = {
  email: string;
  role: "user" | "admin";
  passwordChangeRequired: boolean;
};

export function AccountNavigation() {
  const [account, setAccount] = useState<Account | null>(null);
  useEffect(() => {
    let current = true;
    fetch("/api/account/session", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { account?: Account } | null) => {
        if (current) setAccount(data?.account ?? null);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  async function signOut() {
    await fetch("/api/operations/session/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    setAccount(null);
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
    </div>
  );
}
