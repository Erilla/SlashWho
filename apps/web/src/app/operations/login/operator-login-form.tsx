"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function OperatorLoginForm() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [credential, setCredential] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

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
        body: JSON.stringify({ login, credential: presentedCredential })
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      router.replace("/operations/collection-monitor");
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="operator-login-form" onSubmit={onSubmit}>
      <label htmlFor="operator-login">Login</label>
      <input
        id="operator-login"
        name="login"
        type="text"
        autoComplete="username"
        value={login}
        onChange={(event) => setLogin(event.target.value)}
        required
      />
      <label htmlFor="operator-credential">Credential</label>
      <input
        id="operator-credential"
        name="credential"
        type="password"
        autoComplete="off"
        value={credential}
        onChange={(event) => setCredential(event.target.value)}
        required
      />
      <button className="search-button" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {failed ? <p role="alert">Authentication failed.</p> : null}
    </form>
  );
}
