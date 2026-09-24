"use client";

import { useEffect, useRef, useState } from "react";
import { accountSessionChangedEvent } from "../../lib/account-session-events";

import {
  readStoredCredentials,
  writeStoredCredentials,
  clearStoredCredentials,
  browserProviderValues,
  clearStoredProvider,
  type BrowserCredentialProvider,
  type StoredApiCredentials
} from "../../lib/api-credentials";

const emptyCredentials: StoredApiCredentials = {
  blizzardClientId: "",
  blizzardClientSecret: "",
  raiderIoAccessKey: "",
  wclClientId: "",
  wclClientSecret: ""
};

export default function SettingsPage() {
  const [credentials, setCredentials] = useState(emptyCredentials);
  const [saved, setSaved] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<
    "checking" | "unknown" | "signed-out" | "signed-in"
  >("checking");
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const sessionGeneration = useRef(0);
  const [credentialStatusReady, setCredentialStatusReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [presence, setPresence] = useState<
    Record<BrowserCredentialProvider, { present: boolean; version: number }>
  >({
    blizzard: { present: false, version: 0 },
    raiderio: { present: false, version: 0 },
    warcraftlogs: { present: false, version: 0 }
  });
  const [feedback, setFeedback] = useState("");
  const [replaceChoice, setReplaceChoice] =
    useState<BrowserCredentialProvider | null>(null);

  function refreshSession() {
    sessionGeneration.current += 1;
    setRefreshNonce((current) => current + 1);
  }

  useEffect(() => {
    setCredentials(readStoredCredentials());
    let live = true;
    setSessionStatus("checking");
    setAccountEmail(null);
    setCredentialStatusReady(false);
    setReplaceChoice(null);
    setSaved(false);
    setFeedback("");
    const refresh = () => refreshSession();
    window.addEventListener(accountSessionChangedEvent, refresh);
    window.addEventListener("focus", refresh);
    void fetch("/api/account/session", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("session_unavailable");
        return response.json();
      })
      .then(
        async (result: {
          account?: { email: string; passwordChangeRequired: boolean } | null;
        }) => {
          if (!live) return;
          if (
            result.account &&
            typeof result.account.email === "string" &&
            !result.account.passwordChangeRequired
          ) {
            setAccountEmail(result.account.email);
            setSessionStatus("signed-in");
            const response = await fetch("/api/account/credentials", {
              cache: "no-store"
            });
            if (response.ok) {
              const data = (await response.json()) as {
                providers: {
                  provider: BrowserCredentialProvider;
                  present: boolean;
                  version: number;
                }[];
              };
              if (live)
                setPresence(
                  Object.fromEntries(
                    data.providers.map(({ provider, present, version }) => [
                      provider,
                      { present, version }
                    ])
                  ) as typeof presence
                );
              if (live) setCredentialStatusReady(true);
            } else if (live) {
              setFeedback(
                "Account key storage is unavailable. Try again later."
              );
            }
          } else if (result.account === null) {
            setSessionStatus("signed-out");
          } else {
            throw new Error("invalid_session_response");
          }
        }
      )
      .catch(() => {
        if (live) {
          setSessionStatus("unknown");
          setFeedback(
            "Could not verify your session. Retry before changing keys."
          );
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      window.removeEventListener(accountSessionChangedEvent, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refreshNonce]);

  async function currentSlot(provider: BrowserCredentialProvider) {
    let session: {
      account?: { email: string; passwordChangeRequired: boolean } | null;
    };
    try {
      const sessionResponse = await fetch("/api/account/session", {
        cache: "no-store"
      });
      if (!sessionResponse.ok) throw new Error("session_unavailable");
      session = await sessionResponse.json();
    } catch {
      throw new Error("session_unavailable");
    }
    if (
      !session.account ||
      session.account.passwordChangeRequired ||
      session.account.email !== accountEmail
    ) {
      refreshSession();
      return null;
    }
    const response = await fetch("/api/account/credentials", {
      cache: "no-store"
    });
    if (!response.ok) throw new Error("credentials_unavailable");
    const data = (await response.json()) as {
      providers: {
        provider: BrowserCredentialProvider;
        present: boolean;
        version: number;
      }[];
    };
    const slot = data.providers.find((item) => item.provider === provider);
    if (
      !slot ||
      slot.version !== presence[provider].version ||
      slot.present !== presence[provider].present
    ) {
      refreshSession();
      return null;
    }
    return slot;
  }

  async function accountWrite(
    provider: BrowserCredentialProvider,
    values: Record<string, string>,
    replace: boolean,
    imported: boolean
  ) {
    const generation = sessionGeneration.current;
    try {
      const slot = await currentSlot(provider);
      if (!slot) {
        setFeedback(
          "Account or key status changed. Review the current account and try again."
        );
        return false;
      }
      if (sessionGeneration.current !== generation) return false;
      const response = await fetch("/api/account/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          values,
          replace,
          expectedVersion: slot.version,
          expectedAccountEmail: accountEmail
        })
      });
      if (!response.ok) {
        setFeedback(
          response.status === 409
            ? "This slot changed or needs an explicit replacement choice. Refresh and try again."
            : "Could not save this provider."
        );
        return false;
      }
      if (sessionGeneration.current !== generation) return false;
      if (imported) {
        clearStoredProvider(provider);
        setCredentials(readStoredCredentials());
      }
      setPresence((current) => ({
        ...current,
        [provider]: { present: true, version: current[provider].version + 1 }
      }));
      setReplaceChoice(null);
      setFeedback(`${provider} saved to your account.`);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "session_unavailable") {
        setSessionStatus("unknown");
        setFeedback(
          "Could not verify your session. Retry before changing keys."
        );
      } else {
        setFeedback(
          "Could not save this provider. Check your connection and try again."
        );
      }
      return false;
    }
  }

  async function removeAccountProvider(provider: BrowserCredentialProvider) {
    const generation = sessionGeneration.current;
    try {
      const slot = await currentSlot(provider);
      if (!slot) {
        setFeedback(
          "Account or key status changed. Review the current account and try again."
        );
        return;
      }
      if (sessionGeneration.current !== generation) return;
      const response = await fetch("/api/account/credentials", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          expectedVersion: slot.version,
          expectedAccountEmail: accountEmail
        })
      });
      if (!response.ok) {
        setFeedback("Could not remove this provider.");
        return;
      }
      if (sessionGeneration.current !== generation) return;
      setPresence((current) => ({
        ...current,
        [provider]: { present: false, version: current[provider].version + 1 }
      }));
      setFeedback(`${provider} removed from your account.`);
    } catch (error) {
      if (error instanceof Error && error.message === "session_unavailable") {
        setSessionStatus("unknown");
        setFeedback(
          "Could not verify your session. Retry before changing keys."
        );
      } else {
        setFeedback(
          "Could not remove this provider. Check your connection and try again."
        );
      }
    }
  }

  function field(key: keyof StoredApiCredentials): {
    value: string;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  } {
    return {
      value: credentials[key],
      onChange: (event) => {
        setSaved(false);
        setCredentials((current) => ({
          ...current,
          [key]: event.target.value
        }));
      }
    };
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const generation = sessionGeneration.current;
    try {
      const response = await fetch("/api/account/session", {
        cache: "no-store"
      });
      if (!response.ok) throw new Error("session_unavailable");
      const session = (await response.json()) as { account?: unknown };
      if (sessionGeneration.current !== generation) return;
      if (session.account !== null) {
        refreshSession();
        return;
      }
      writeStoredCredentials(credentials);
      setSaved(true);
    } catch {
      if (sessionGeneration.current !== generation) return;
      setSessionStatus("unknown");
      setFeedback("Could not verify your session. Retry before changing keys.");
    }
  }

  function onClear() {
    clearStoredCredentials();
    setCredentials(emptyCredentials);
    setSaved(false);
  }

  return (
    <main className="page-shell document-page settings-page">
      <h1>Your API keys</h1>
      {loading || sessionStatus === "checking" ? (
        <p role="status">Loading key settings…</p>
      ) : sessionStatus === "unknown" ? (
        <>
          <p role="alert">{feedback}</p>
          <button type="button" onClick={refreshSession}>
            Retry session check
          </button>
        </>
      ) : sessionStatus === "signed-in" ? (
        <>
          <p>
            Saved account keys are encrypted and never shown again. Enter a
            complete provider credential to save or replace it.
          </p>
          {credentialStatusReady
            ? (["blizzard", "raiderio", "warcraftlogs"] as const).map(
                (provider) => {
                  const local = browserProviderValues(credentials, provider);
                  const slot = presence[provider];
                  return (
                    <section key={`${accountEmail}:${provider}`}>
                      <h2>
                        {provider === "raiderio"
                          ? "Raider.IO"
                          : provider === "warcraftlogs"
                            ? "Warcraft Logs"
                            : "Blizzard"}
                      </h2>
                      <p>
                        {slot.present
                          ? "Saved in account"
                          : "No account key saved"}
                      </p>
                      {local ? (
                        <div>
                          <p>Browser copy found.</p>
                          {slot.present && replaceChoice !== provider ? (
                            <button
                              type="button"
                              onClick={() => setReplaceChoice(provider)}
                            >
                              Choose replacement
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                void accountWrite(
                                  provider,
                                  local,
                                  slot.present,
                                  true
                                )
                              }
                            >
                              {slot.present
                                ? "Replace with browser copy"
                                : "Import browser copy"}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setReplaceChoice(null)}
                          >
                            Cancel import
                          </button>
                        </div>
                      ) : null}
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          const data = new FormData(event.currentTarget);
                          const values: Record<string, string> =
                            provider === "raiderio"
                              ? {
                                  accessKey: String(data.get("accessKey") ?? "")
                                }
                              : {
                                  clientId: String(data.get("clientId") ?? ""),
                                  clientSecret: String(
                                    data.get("clientSecret") ?? ""
                                  )
                                };
                          const form = event.currentTarget;
                          void accountWrite(
                            provider,
                            values,
                            slot.present,
                            false
                          ).then((saved) => {
                            if (saved) form.reset();
                          });
                        }}
                      >
                        {provider === "raiderio" ? (
                          <label>
                            Access key
                            <input
                              name="accessKey"
                              type="password"
                              autoComplete="off"
                              required
                            />
                          </label>
                        ) : (
                          <>
                            <label>
                              Client ID
                              <input
                                name="clientId"
                                autoComplete="off"
                                required
                              />
                            </label>
                            <label>
                              Client secret
                              <input
                                name="clientSecret"
                                type="password"
                                autoComplete="off"
                                required
                              />
                            </label>
                          </>
                        )}
                        <button type="submit">
                          {slot.present
                            ? "Replace account key"
                            : "Save account key"}
                        </button>
                      </form>
                      {slot.present ? (
                        <button
                          type="button"
                          onClick={() => void removeAccountProvider(provider)}
                        >
                          Remove account key
                        </button>
                      ) : null}
                    </section>
                  );
                }
              )
            : null}
          {feedback ? <p role="status">{feedback}</p> : null}
        </>
      ) : (
        <>
          <p>
            Supply your own Blizzard, Raider.IO, and Warcraft Logs API
            credentials to use your own upstream rate-limit budget instead of
            SlashWho&apos;s shared one. These are stored only in this browser
            and are never sent anywhere except to the matching provider&apos;s
            API.
          </p>
          <form onSubmit={onSubmit}>
            <fieldset>
              <legend>Blizzard</legend>
              <label>
                Client ID
                <input
                  type="text"
                  autoComplete="off"
                  {...field("blizzardClientId")}
                />
              </label>
              <label>
                Client secret
                <input
                  type="password"
                  autoComplete="off"
                  {...field("blizzardClientSecret")}
                />
              </label>
            </fieldset>
            <fieldset>
              <legend>Raider.IO</legend>
              <label>
                Access key
                <input
                  type="password"
                  autoComplete="off"
                  {...field("raiderIoAccessKey")}
                />
              </label>
            </fieldset>
            <fieldset>
              <legend>Warcraft Logs</legend>
              <label>
                Client ID
                <input
                  type="text"
                  autoComplete="off"
                  {...field("wclClientId")}
                />
              </label>
              <label>
                Client secret
                <input
                  type="password"
                  autoComplete="off"
                  {...field("wclClientSecret")}
                />
              </label>
            </fieldset>
            <div className="settings-actions">
              <button className="search-button" type="submit">
                Save
              </button>
              <button className="search-button" type="button" onClick={onClear}>
                Clear all
              </button>
            </div>
            {saved ? <p role="status">Saved.</p> : null}
          </form>
        </>
      )}
    </main>
  );
}
