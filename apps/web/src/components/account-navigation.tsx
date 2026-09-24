"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
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
  return (
    <div className="header-menu" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className="header-menu-trigger"
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="header-menu-panel"
        onClick={() => setOpen((current) => !current)}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      {open && (
        <nav id="header-menu-panel" aria-label="Primary" className="site-nav">
          {account ? (
            <>
              <span className="header-menu-email">{account.email}</span>
              <Link href="/account" onClick={() => setOpen(false)}>
                Account
              </Link>
            </>
          ) : (
            <>
              <Link href="/operations/login" onClick={() => setOpen(false)}>
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 3h6v18h-6M3 12h13m-5-5 5 5-5 5" />
                </svg>
                Sign in
              </Link>
              <Link href="/account/create" onClick={() => setOpen(false)}>
                Create account
              </Link>
            </>
          )}
          <Link href="/changelog" onClick={() => setOpen(false)}>
            Changelog
          </Link>
          <Link href="/settings" onClick={() => setOpen(false)}>
            Settings
          </Link>
          {account?.role === "admin" && !account.passwordChangeRequired && (
            <>
              <Link href="/admin/settings" onClick={() => setOpen(false)}>
                Admin settings
              </Link>
              <Link
                href="/operations/collection-monitor"
                onClick={() => setOpen(false)}
              >
                Collection monitor
              </Link>
            </>
          )}
          {account && (
            <button type="button" onClick={signOut}>
              Sign out
            </button>
          )}
          {signOutError && <p role="alert">{signOutError}</p>}
        </nav>
      )}
    </div>
  );
}
