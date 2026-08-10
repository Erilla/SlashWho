import { supportedRegions, type CharacterKey } from "@slashwho/domain";

import type {
  AchievementFingerprint,
  BlizzardError,
  BlizzardFailure,
  BlizzardGateway,
  BlizzardRosterCharacter
} from "./types";

export type CreateBlizzardClientOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  clientId: string;
  clientSecret: string;
  /** Overrides both Blizzard hosts for deterministic local integration tests. */
  baseUrl?: string;
}>;

type AccessToken = Readonly<{
  value: string;
  expiresAt: number;
}>;

function createBlizzardError(failure: BlizzardFailure): BlizzardError {
  return Object.assign(
    new Error(`blizzard_${failure.kind}`),
    failure
  ) as BlizzardError;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;

  if (/^\d+$/.test(value)) return Number(value) * 1_000;

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : undefined;
}

function responseFailure(response: Response): BlizzardFailure {
  if (response.status === 404) return { kind: "not_found" };

  const retryAfter = retryAfterMs(response);
  return {
    kind: "transient",
    status: response.status,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter })
  };
}

function validCharacterKey(value: CharacterKey): CharacterKey {
  const valid =
    supportedRegions.includes(value.region) &&
    /^[a-z0-9-]+$/.test(value.realm) &&
    /^[\p{L}\p{M}'-]+$/u.test(value.name) &&
    value.realm === value.realm.toLocaleLowerCase("en-US") &&
    value.name === value.name.toLocaleLowerCase("en-US");
  if (!valid) throw new Error("invalid_character_key");
  return value;
}

function valueRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedRosterCharacter(
  value: unknown,
  region: CharacterKey["region"]
): BlizzardRosterCharacter | null {
  const member = valueRecord(value);
  const character = member && valueRecord(member.character);
  const realm = character && valueRecord(character.realm);
  const playableClass = character && valueRecord(character.playable_class);
  const displayName = character && nonEmptyString(character.name);
  const realmSlug = realm && nonEmptyString(realm.slug);
  const className = playableClass && nonEmptyString(playableClass.name);
  const level = character && finiteNumber(character.level);
  if (
    !displayName ||
    !realmSlug ||
    !className ||
    level === null ||
    !Number.isInteger(level) ||
    level < 0
  ) {
    return null;
  }

  const key = {
    region,
    realm: realmSlug.toLocaleLowerCase("en-US"),
    name: displayName.toLocaleLowerCase("en-US")
  } as CharacterKey;
  try {
    validCharacterKey(key);
  } catch {
    return null;
  }

  return { key, displayName, className, level };
}

function fingerprintFromResponse(
  value: unknown
): AchievementFingerprint | null {
  const response = valueRecord(value);
  if (!response || !Array.isArray(response.achievements)) return null;

  const fingerprint = new Map<number, number>();
  for (const achievement of response.achievements) {
    const entry = valueRecord(achievement);
    const id = entry && finiteNumber(entry.id);
    const timestamp = entry && finiteNumber(entry.completed_timestamp);
    if (id !== null && timestamp !== null) fingerprint.set(id, timestamp);
  }
  return fingerprint;
}

function blizzardSlug(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, "-");
}

export function createBlizzardClient(
  options: CreateBlizzardClientOptions
): BlizzardGateway {
  let cachedToken: AccessToken | undefined;

  async function accessToken(signal?: AbortSignal): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      return cachedToken.value;
    }

    let response: Response;
    try {
      response = await options.fetch(
        new URL(
          "/token",
          options.baseUrl ?? "https://oauth.battle.net"
        ).toString(),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(
              `${options.clientId}:${options.clientSecret}`
            ).toString("base64")}`
          },
          body: "grant_type=client_credentials",
          signal
        }
      );
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw createBlizzardError({ kind: "transient" });
    }

    signal?.throwIfAborted();
    if (!response.ok) throw createBlizzardError(responseFailure(response));

    try {
      const body = valueRecord(await response.json());
      signal?.throwIfAborted();
      const token = body && nonEmptyString(body.access_token);
      const expiresIn = body && finiteNumber(body.expires_in);
      if (!token || expiresIn === null || expiresIn <= 0) {
        throw new Error("invalid_token_response");
      }
      cachedToken = {
        value: token,
        expiresAt: Date.now() + Math.max(0, expiresIn * 1_000 - 60_000)
      };
      return token;
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw createBlizzardError({ kind: "schema_drift" });
    }
  }

  async function request<T>(
    url: URL,
    normalize: (value: unknown) => T | null,
    signal?: AbortSignal
  ): Promise<T> {
    const token = await accessToken(signal);
    let response: Response;
    try {
      response = await options.fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        },
        signal
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw createBlizzardError({ kind: "transient" });
    }

    signal?.throwIfAborted();
    if (!response.ok) throw createBlizzardError(responseFailure(response));

    try {
      const normalized = normalize(await response.json());
      signal?.throwIfAborted();
      if (normalized === null) throw new Error("invalid_response");
      return normalized;
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw createBlizzardError({ kind: "schema_drift" });
    }
  }

  function profileUrl(key: CharacterKey): URL {
    const url = new URL(
      `/profile/wow/character/${encodeURIComponent(key.realm)}/${encodeURIComponent(key.name)}`,
      options.baseUrl ?? `https://${key.region}.api.blizzard.com`
    );
    url.searchParams.set("namespace", `profile-${key.region}`);
    url.searchParams.set("locale", "en_GB");
    return url;
  }

  function achievementsUrl(key: CharacterKey): URL {
    const url = profileUrl(key);
    url.pathname = `${url.pathname}/achievements`;
    return url;
  }

  function rosterUrl(
    region: CharacterKey["region"],
    realm: string,
    guildName: string
  ): URL {
    const url = new URL(
      `/data/wow/guild/${encodeURIComponent(blizzardSlug(realm))}/${encodeURIComponent(blizzardSlug(guildName))}/roster`,
      options.baseUrl ?? `https://${region}.api.blizzard.com`
    );
    url.searchParams.set("namespace", `profile-${region}`);
    url.searchParams.set("locale", "en_GB");
    return url;
  }

  async function getGuildRoster(
    root: CharacterKey,
    signal?: AbortSignal
  ): Promise<readonly BlizzardRosterCharacter[]> {
    const key = validCharacterKey(root);
    const profile = await request(
      profileUrl(key),
      (value) => valueRecord(value),
      signal
    );
    if (!("guild" in profile) || profile.guild === null) return [];

    const guild = valueRecord(profile.guild);
    const name = guild && nonEmptyString(guild.name);
    const realm = guild && valueRecord(guild.realm);
    const realmSlug = realm && nonEmptyString(realm.slug);
    if (!name || !realmSlug)
      throw createBlizzardError({ kind: "schema_drift" });

    return request(
      rosterUrl(key.region, realmSlug, name),
      (value) => {
        const roster = valueRecord(value);
        if (!roster || !Array.isArray(roster.members)) return null;
        const members = roster.members.map((member) =>
          normalizedRosterCharacter(member, key.region)
        );
        return members.every((member) => member !== null)
          ? (members as BlizzardRosterCharacter[])
          : null;
      },
      signal
    );
  }

  async function getAchievementFingerprint(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<AchievementFingerprint> {
    const validKey = validCharacterKey(key);
    return request(achievementsUrl(validKey), fingerprintFromResponse, signal);
  }

  return { getGuildRoster, getAchievementFingerprint };
}

export { createBlizzardError };
