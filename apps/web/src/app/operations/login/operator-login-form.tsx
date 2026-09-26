"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { notifyAccountSessionChanged } from "../../../lib/account-session-events";

export function OperatorLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [credential, setCredential] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (failed) feedbackRef.current?.focus();
  }, [failed]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setFailed(false);
    const presentedCredential = credential;
    setCredential("");

    try {
      const response = await fetch("/api/operations/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: presentedCredential })
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      notifyAccountSessionChanged();
      router.replace(
        response.headers.get("x-password-change-required") === "1"
          ? "/account/change-password"
          : "/account"
      );
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="operator-login-form" onSubmit={onSubmit}>
      <label htmlFor="operator-login">Email address</label>
      <input
        id="operator-login"
        name="email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />
      <label htmlFor="operator-credential">Password</label>
      <input
        id="operator-credential"
        name="password"
        type="password"
        autoComplete="current-password"
        minLength={6}
        value={credential}
        onChange={(event) => setCredential(event.target.value)}
        required
      />
      <button className="search-button" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {failed ? (
        <p role="alert" tabIndex={-1} ref={feedbackRef}>
          Sign in failed. Check your email and password.
        </p>
      ) : null}
      <p>
        <Link href="/account/create">Create account</Link> ·{" "}
        <Link href="/account/recover">Forgot password?</Link> ·{" "}
        <Link href="/account/verify">Resend verification</Link>
      </p>
    </form>
  );
}
