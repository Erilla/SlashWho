import {
  supportedRegions,
  type CharacterGuild,
  type CharacterKey
} from "@slashwho/domain";

import type {
  AchievementFingerprint,
  BlizzardError,
  BlizzardFailure,
  BlizzardGateway,
  BlizzardProfileRequestObserver,
  BlizzardRosterCharacter,
  CompletedAchievement
} from "./types";

export type CreateBlizzardClientOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  clientId: string;
  clientSecret: string;
  /** Overrides both Blizzard hosts for deterministic local integration tests. */
  baseUrl?: string;
  onThrottle?(event: { retryAfterMs: number | undefined }): void;
}>;

type AccessToken = Readonly<{
  value: string;
  expiresAt: number;
}>;

type CachedPlayableClassNames = Readonly<{
  names: ReadonlyMap<number, string>;
  expiresAt: number;
}>;

// Playable classes are static data, but a live patch can change them. A daily
// refresh bounds the maximum patch staleness without retaining any profile,
// roster, or fingerprint material.
const PLAYABLE_CLASS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

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

/**
 * A reporting callback must never change what this client returns. If the
 * logger behind `onThrottle` throws, the raw thrown value would otherwise
 * replace the failure being built here, degrading a genuine rate limit into an
 * unavailable upstream. Swallowed silently: there is no safe place to report a
 * failure of the reporting path itself, and it must not become a second
 * failure.
 */
function reportThrottle(
  onThrottle:
    ((event: { retryAfterMs: number | undefined }) => void) | undefined,
  retryAfterMs: number | undefined
): void {
  try {
    onThrottle?.({ retryAfterMs });
  } catch {
    // Intentionally ignored; see above.
  }
}

function responseFailure(
  response: Response,
  onThrottle?: (event: { retryAfterMs: number | undefined }) => void
): BlizzardFailure {
  if (response.status === 404) return { kind: "not_found" };

  const retryAfter = retryAfterMs(response);
  if (response.status === 429 || retryAfter !== undefined) {
    reportThrottle(onThrottle, retryAfter);
  }
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

function validGuild(value: CharacterGuild): CharacterGuild {
  const valid =
    supportedRegions.includes(value.region) &&
    /^[a-z0-9-]+$/.test(value.realm) &&
    value.realm === value.realm.toLocaleLowerCase("en-US") &&
    typeof value.name === "string" &&
    value.name.trim().length > 0;
  if (!valid) throw new Error("invalid_guild_identity");
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
  region: CharacterKey["region"],
  classNames: ReadonlyMap<number, string>,
  guild: BlizzardRosterCharacter["guild"]
): BlizzardRosterCharacter | null {
  const member = valueRecord(value);
  const character = member && valueRecord(member.character);
  const realm = character && valueRecord(character.realm);
  const playableClass = character && valueRecord(character.playable_class);
  const displayName = character && nonEmptyString(character.name);
  const realmSlug = realm && nonEmptyString(realm.slug);
  // A roster member carries only its class id; Blizzard sends the name from the
  // static playable-class index, not from the roster itself.
  const classId = playableClass && finiteNumber(playableClass.id);
  const className =
    (playableClass && nonEmptyString(playableClass.name)) ??
    (classId === null ? null : (classNames.get(classId) ?? null));
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

  return { key, displayName, className, level, guild };
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

function completedAchievementsFromResponse(
  value: unknown
): readonly CompletedAchievement[] | null {
  const response = valueRecord(value);
  if (!response || !Array.isArray(response.achievements)) return null;

  const achievements: CompletedAchievement[] = [];
  for (const achievement of response.achievements) {
    const entry = valueRecord(achievement);
    const id = entry && finiteNumber(entry.id);
    if (entry === null || id === null || !Number.isSafeInteger(id) || id <= 0)
      return null;
    if (!("completed_timestamp" in entry)) continue;
    const timestamp = finiteNumber(entry.completed_timestamp);
    if (
      timestamp === null ||
      !Number.isSafeInteger(timestamp) ||
      timestamp <= 0
    )
      return null;
    const completedDate = new Date(timestamp);
    if (Number.isNaN(completedDate.getTime())) return null;
    const completedAt = completedDate.toISOString();
    achievements.push({ achievementId: String(id), completedAt });
  }
  return achievements;
}

function blizzardSlug(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, "-");
}

export function createBlizzardClient(
  options: CreateBlizzardClientOptions
): BlizzardGateway {
  let cachedToken: AccessToken | undefined;
  let tokenRequest: Promise<string> | undefined;
  const cachedClassNames = new Map<
    CharacterKey["region"],
    CachedPlayableClassNames
  >();

  async function accessToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    tokenRequest ??= fetchAccessToken(AbortSignal.timeout(15_000)).finally(
      () => {
        tokenRequest = undefined;
      }
    );
    const token = await tokenRequest;
    signal?.throwIfAborted();
    return token;
  }

  // The signal is the token request's own deadline, never a caller's: the
  // request is shared, so its expiry is an upstream failure, not a
  // cancellation, and is reported like any other.
  async function fetchAccessToken(signal?: AbortSignal): Promise<string> {
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
      throw createBlizzardError({ kind: "transient" });
    }

    if (signal?.aborted) throw createBlizzardError({ kind: "transient" });
    if (!response.ok)
      throw createBlizzardError(responseFailure(response, options.onThrottle));

    try {
      const body = valueRecord(await response.json());
      if (signal?.aborted) throw new Error("token_deadline");
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
      if (signal?.aborted) throw createBlizzardError({ kind: "transient" });
      throw createBlizzardError({ kind: "schema_drift" });
    }
  }

  async function request<T>(
    url: URL,
    normalize: (value: unknown) => T | null,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver
  ): Promise<T> {
    const token = await accessToken(signal);
    await onProfileRequest?.();
    signal?.throwIfAborted();
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
    if (!response.ok)
      throw createBlizzardError(responseFailure(response, options.onThrottle));

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

  function playableClassIndexUrl(region: CharacterKey["region"]): URL {
    const url = new URL(
      "/data/wow/playable-class/index",
      options.baseUrl ?? `https://${region}.api.blizzard.com`
    );
    url.searchParams.set("namespace", `static-${region}`);
    url.searchParams.set("locale", "en_GB");
    return url;
  }

  async function playableClassNames(
    region: CharacterKey["region"],
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver
  ): Promise<ReadonlyMap<number, string>> {
    const cached = cachedClassNames.get(region);
    if (cached && cached.expiresAt > Date.now()) return cached.names;

    // Names are static only within a region. Each first read is requested with
    // the sweep observer, so it remains accounted for like every other
    // upstream call. The daily expiry bounds staleness across a live patch.
    const names = await request(
      playableClassIndexUrl(region),
      (value) => {
        const body = valueRecord(value);
        if (!body || !Array.isArray(body.classes)) return null;
        const names = new Map<number, string>();
        for (const entry of body.classes) {
          const playableClass = valueRecord(entry);
          const id = playableClass && finiteNumber(playableClass.id);
          const name = playableClass && nonEmptyString(playableClass.name);
          if (id !== null && name) names.set(id, name);
        }
        return names.size > 0 ? names : null;
      },
      signal,
      onProfileRequest
    );
    cachedClassNames.set(region, {
      names,
      expiresAt: Date.now() + PLAYABLE_CLASS_CACHE_TTL_MS
    });
    return names;
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
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver
  ): Promise<readonly BlizzardRosterCharacter[]> {
    const key = validCharacterKey(root);
    const profile = await request(
      profileUrl(key),
      (value) => valueRecord(value),
      signal,
      onProfileRequest
    );
    if (!("guild" in profile) || profile.guild === null) return [];

    const guild = valueRecord(profile.guild);
    const name = guild && nonEmptyString(guild.name);
    const realm = guild && valueRecord(guild.realm);
    const realmSlug = realm && nonEmptyString(realm.slug);
    if (!name || !realmSlug)
      throw createBlizzardError({ kind: "schema_drift" });

    return getGuildRosterByIdentity(
      { name, region: key.region, realm: realmSlug },
      signal,
      onProfileRequest
    );
  }

  async function getGuildRosterByIdentity(
    guild: CharacterGuild,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver
  ): Promise<readonly BlizzardRosterCharacter[]> {
    const validGuildIdentity = validGuild(guild);
    const classNames = await playableClassNames(
      validGuildIdentity.region,
      signal,
      onProfileRequest
    );

    return request(
      rosterUrl(
        validGuildIdentity.region,
        validGuildIdentity.realm,
        validGuildIdentity.name
      ),
      (value) => {
        const roster = valueRecord(value);
        if (!roster || !Array.isArray(roster.members)) return null;
        // A member the key space cannot represent is skipped, not fatal: one
        // such member would otherwise abandon the entire sweep. Only a missing
        // members array is structural change.
        return roster.members
          .map((member) =>
            normalizedRosterCharacter(
              member,
              validGuildIdentity.region,
              classNames,
              validGuildIdentity
            )
          )
          .filter(
            (member): member is BlizzardRosterCharacter => member !== null
          );
      },
      signal,
      onProfileRequest
    );
  }

  async function getAchievementFingerprint(
    key: CharacterKey,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver
  ): Promise<AchievementFingerprint> {
    const validKey = validCharacterKey(key);
    return request(
      achievementsUrl(validKey),
      fingerprintFromResponse,
      signal,
      onProfileRequest
    );
  }

  async function getCompletedAchievements(
    key: CharacterKey,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver
  ): Promise<readonly CompletedAchievement[]> {
    const validKey = validCharacterKey(key);
    return request(
      achievementsUrl(validKey),
      completedAchievementsFromResponse,
      signal,
      onProfileRequest
    );
  }

  return {
    getGuildRoster,
    getGuildRosterByIdentity,
    getAchievementFingerprint,
    getCompletedAchievements
  };
}

export { createBlizzardError };
