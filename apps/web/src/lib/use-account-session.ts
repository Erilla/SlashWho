"use client";
import { useEffect, useState } from "react";
import { accountSessionChangedEvent } from "./account-session-events";

export type AccountSession = {
  email: string;
  role: "user" | "admin";
  passwordChangeRequired: boolean;
};

/**
 * The signed-in account, refreshed whenever the session changes or the window
 * regains focus. `undefined` until the first answer arrives; `null` when
 * signed out or the session cannot be read.
 */
export function useAccountSession(): AccountSession | null | undefined {
  const [account, setAccount] = useState<AccountSession | null | undefined>(
    undefined
  );
  useEffect(() => {
    let current = true;
    let generation = 0;
    function refresh() {
      const requestGeneration = ++generation;
      fetch("/api/account/session", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { account?: AccountSession } | null) => {
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
  return account;
}
