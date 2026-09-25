"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { notifyAccountSessionChanged } from "../lib/account-session-events";
import { useAccountSession } from "../lib/use-account-session";

export function AccountNavigation() {
  const account = useAccountSession();
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
