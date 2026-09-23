const STORAGE_KEY = "slashwho:api-credentials";

export type StoredApiCredentials = {
  blizzardClientId: string;
  blizzardClientSecret: string;
  raiderIoAccessKey: string;
  wclClientId: string;
  wclClientSecret: string;
};

const empty: StoredApiCredentials = {
  blizzardClientId: "",
  blizzardClientSecret: "",
  raiderIoAccessKey: "",
  wclClientId: "",
  wclClientSecret: ""
};

export function readStoredCredentials(): StoredApiCredentials {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...empty };
    const parsed = JSON.parse(raw) as Partial<StoredApiCredentials>;
    return {
      blizzardClientId: parsed.blizzardClientId ?? "",
      blizzardClientSecret: parsed.blizzardClientSecret ?? "",
      raiderIoAccessKey: parsed.raiderIoAccessKey ?? "",
      wclClientId: parsed.wclClientId ?? "",
      wclClientSecret: parsed.wclClientSecret ?? ""
    };
  } catch {
    return { ...empty };
  }
}

export function writeStoredCredentials(value: StoredApiCredentials): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable (private browsing, quota). Credentials simply
    // won't persist across reloads; nothing else depends on this write.
  }
}

export function clearStoredCredentials(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // See writeStoredCredentials.
  }
}

export type BrowserCredentialProvider =
  "blizzard" | "raiderio" | "warcraftlogs";

export function browserProviderValues(
  credentials: StoredApiCredentials,
  provider: BrowserCredentialProvider
): Record<string, string> | null {
  if (provider === "raiderio")
    return credentials.raiderIoAccessKey
      ? { accessKey: credentials.raiderIoAccessKey }
      : null;
  const clientId =
    provider === "blizzard"
      ? credentials.blizzardClientId
      : credentials.wclClientId;
  const clientSecret =
    provider === "blizzard"
      ? credentials.blizzardClientSecret
      : credentials.wclClientSecret;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function clearStoredProvider(provider: BrowserCredentialProvider): void {
  const current = readStoredCredentials();
  if (provider === "blizzard") {
    current.blizzardClientId = "";
    current.blizzardClientSecret = "";
  }
  if (provider === "raiderio") current.raiderIoAccessKey = "";
  if (provider === "warcraftlogs") {
    current.wclClientId = "";
    current.wclClientSecret = "";
  }
  writeStoredCredentials(current);
}

export function credentialHeaders(
  credentials: StoredApiCredentials
): HeadersInit {
  const headers: Record<string, string> = {};
  if (credentials.blizzardClientId && credentials.blizzardClientSecret) {
    headers["x-blizzard-client-id"] = credentials.blizzardClientId;
    headers["x-blizzard-client-secret"] = credentials.blizzardClientSecret;
  }
  if (credentials.raiderIoAccessKey) {
    headers["x-raiderio-access-key"] = credentials.raiderIoAccessKey;
  }
  if (credentials.wclClientId && credentials.wclClientSecret) {
    headers["x-wcl-client-id"] = credentials.wclClientId;
    headers["x-wcl-client-secret"] = credentials.wclClientSecret;
  }
  return headers;
}
