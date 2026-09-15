"use client";

import { useEffect, useState } from "react";

import {
  readStoredCredentials,
  writeStoredCredentials,
  clearStoredCredentials,
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

  useEffect(() => {
    setCredentials(readStoredCredentials());
  }, []);

  function field(key: keyof StoredApiCredentials): {
    value: string;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  } {
    return {
      value: credentials[key],
      onChange: (event) => {
        setSaved(false);
        setCredentials((current) => ({ ...current, [key]: event.target.value }));
      }
    };
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    writeStoredCredentials(credentials);
    setSaved(true);
  }

  function onClear() {
    clearStoredCredentials();
    setCredentials(emptyCredentials);
    setSaved(false);
  }

  return (
    <main className="page-shell document-page settings-page">
      <h1>Your API keys</h1>
      <p>
        Supply your own Blizzard, Raider.IO, and Warcraft Logs API credentials
        to use your own upstream rate-limit budget instead of SlashWho&apos;s
        shared one. These are stored only in this browser and are never sent
        anywhere except to the matching provider&apos;s API.
      </p>
      <form onSubmit={onSubmit}>
        <fieldset>
          <legend>Blizzard</legend>
          <label>
            Client ID
            <input type="text" autoComplete="off" {...field("blizzardClientId")} />
          </label>
          <label>
            Client secret
            <input type="password" autoComplete="off" {...field("blizzardClientSecret")} />
          </label>
        </fieldset>
        <fieldset>
          <legend>Raider.IO</legend>
          <label>
            Access key
            <input type="password" autoComplete="off" {...field("raiderIoAccessKey")} />
          </label>
        </fieldset>
        <fieldset>
          <legend>Warcraft Logs</legend>
          <label>
            Client ID
            <input type="text" autoComplete="off" {...field("wclClientId")} />
          </label>
          <label>
            Client secret
            <input type="password" autoComplete="off" {...field("wclClientSecret")} />
          </label>
        </fieldset>
        <button type="submit">Save</button>
        <button type="button" onClick={onClear}>
          Clear all
        </button>
        {saved ? <p role="status">Saved.</p> : null}
      </form>
    </main>
  );
}
