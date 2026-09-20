"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function OperatorLoginForm() {
  const router = useRouter();
  const [operatorKey, setOperatorKey] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setFailed(false);
    const presentedKey = operatorKey;
    setOperatorKey("");

    try {
      const response = await fetch("/api/operations/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorKey: presentedKey })
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
      <label htmlFor="operator-key">Operator key</label>
      <input
        id="operator-key"
        name="operatorKey"
        type="password"
        autoComplete="off"
        value={operatorKey}
        onChange={(event) => setOperatorKey(event.target.value)}
        required
      />
      <button className="search-button" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {failed ? <p role="alert">Authentication failed.</p> : null}
    </form>
  );
}
