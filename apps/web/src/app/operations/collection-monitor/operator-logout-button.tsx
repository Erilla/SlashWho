"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function OperatorLogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function logout() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch("/api/operations/session", {
        method: "DELETE"
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      router.replace("/operations/login");
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="operator-logout">
      <button
        className="secondary-button"
        type="button"
        disabled={pending}
        onClick={logout}
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {failed ? <span role="alert">Sign out failed.</span> : null}
    </div>
  );
}
