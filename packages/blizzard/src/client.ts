import {
  isValidCharacterKey,
  supportedRegions,
  type CharacterGuild,
  type CharacterKey
} from "@slashwho/domain";
import {
  classifyResponse,
  createClientCredentialsTokenSource,
  createUpstreamError,
  finiteNumber,
  nonEmptyString,
  record as valueRecord,
  type ThrottleObserver,
  type UpstreamError,
  type UpstreamFailure
} from "@slashwho/upstream-http";

import type {
  AchievementFingerprint,
  BlizzardGateway,
  BlizzardProfileRequestObserver,
  BlizzardSlotWait,
  BlizzardRosterCharacter,
  CompletedAchievement
} from "./types";
import {
  fingerprintFromResponse,
  type FingerprintParser
} from "./fingerprint-parser";
import { createRequestLimiter, type RequestLimits } from "./request-limiter";

export type CreateBlizzardClientOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  clientId: string;
  clientSecret: string;
  /** Overrides both Blizzard hosts for deterministic local integration tests. */
  baseUrl?: string | undefined;
  onThrottle?: ThrottleObserver;
  /**
   * Bounds every API read this client makes, across all of its callers. A
   * process that shares one client between several consumers of the same
   * credentials shares these limits too; the OAuth token fetch is exempt.
   */
  requestLimits?: RequestLimits;
  /**
   * Where an achievements body is parsed into a fingerprint. Defaults to the
   * calling thread; a process that sweeps many characters passes a pool so the
   * 1.9 MB parse does not queue behind everything else on its main thread.
   */
  fingerprintParser?: FingerprintParser;
}>;

type CachedPlayableClassNames = Readonly<{
  names: ReadonlyMap<number, string>;
  expiresAt: number;
}>;

// Playable classes are static data, but a live patch can change them. A daily
// refresh bounds the maximum patch staleness without retaining any profile,
// roster, or fingerprint material.
const PLAYABLE_CLASS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

type BodyReader = (response: Response) => Promise<unknown>;

const readJson: BodyReader = (response) => response.json();

function createBlizzardError(failure: UpstreamFailure): UpstreamError {
  return createUpstreamError("blizzard", failure);
}

/**
 * This client has always read a 403 as transient, never as a refusal about
 * the character, and its callers retry on that basis. Kept as it was: this
 * client never throws `forbidden`.
 */
function responseFailure(
  response: Response,
  onThrottle?: ThrottleObserver
): UpstreamFailure {
  const failure = classifyResponse(response, onThrottle);
  return failure.kind === "forbidden"
    ? { kind: "transient", status: response.status }
    : failure;
}

function validCharacterKey(value: CharacterKey): CharacterKey {
  if (!isValidCharacterKey(value)) throw new Error("invalid_character_key");
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
  const tokens = createClientCredentialsTokenSource({
    provider: "blizzard",
    fetch: options.fetch,
    url: new URL("/token", options.baseUrl ?? "https://oauth.battle.net"),
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    onThrottle: options.onThrottle
  });
  const cachedClassNames = new Map<
    CharacterKey["region"],
    CachedPlayableClassNames
  >();
  const limiter = options.requestLimits
    ? createRequestLimiter(options.requestLimits)
    : undefined;

  async function request<T>(
    url: URL,
    normalize: (value: unknown) => T | null,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver,
    waitForSlot?: BlizzardSlotWait,
    readBody: BodyReader = readJson
  ): Promise<T> {
    const token = await tokens.token(signal);
    await onProfileRequest?.();
    signal?.throwIfAborted();
    if (!limiter) return send(url, token, normalize, signal, readBody);
    const acquire = () => limiter.acquire(signal);
    const release = await (waitForSlot ? waitForSlot(acquire) : acquire());
    // The slot is held until the body is read, so a slow body still counts
    // against the requests in flight.
    try {
      return await send(url, token, normalize, signal, readBody);
    } finally {
      release();
    }
  }

  async function send<T>(
    url: URL,
    token: string,
    normalize: (value: unknown) => T | null,
    signal: AbortSignal | undefined,
    readBody: BodyReader
  ): Promise<T> {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await options.fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        },
        signal: signal ?? null
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw createBlizzardError({ kind: "transient" });
    }

    signal?.throwIfAborted();
    if (!response.ok)
      throw createBlizzardError(responseFailure(response, options.onThrottle));

    try {
      const normalized = normalize(await readBody(response));
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
    onProfileRequest?: BlizzardProfileRequestObserver,
    waitForSlot?: BlizzardSlotWait
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
      onProfileRequest,
      waitForSlot
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
    onProfileRequest?: BlizzardProfileRequestObserver,
    waitForSlot?: BlizzardSlotWait
  ): Promise<readonly BlizzardRosterCharacter[]> {
    const key = validCharacterKey(root);
    const profile = await request(
      profileUrl(key),
      (value) => valueRecord(value),
      signal,
      onProfileRequest,
      waitForSlot
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
      onProfileRequest,
      waitForSlot
    );
  }

  async function getGuildRosterByIdentity(
    guild: CharacterGuild,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver,
    waitForSlot?: BlizzardSlotWait
  ): Promise<readonly BlizzardRosterCharacter[]> {
    const validGuildIdentity = validGuild(guild);
    const classNames = await playableClassNames(
      validGuildIdentity.region,
      signal,
      onProfileRequest,
      waitForSlot
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
      onProfileRequest,
      waitForSlot
    );
  }

  async function getAchievementFingerprint(
    key: CharacterKey,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver,
    waitForSlot?: BlizzardSlotWait
  ): Promise<AchievementFingerprint> {
    const validKey = validCharacterKey(key);
    const parser = options.fingerprintParser;
    if (!parser) {
      return request(
        achievementsUrl(validKey),
        fingerprintFromResponse,
        signal,
        onProfileRequest,
        waitForSlot
      );
    }
    // The body is read as bytes and parsed by the parser, so the body read is
    // what the request's slot is held for, as before.
    return request(
      achievementsUrl(validKey),
      (value) => value as AchievementFingerprint | null,
      signal,
      onProfileRequest,
      waitForSlot,
      async (response) => parser.parse(await response.arrayBuffer())
    );
  }

  async function getCompletedAchievements(
    key: CharacterKey,
    signal?: AbortSignal,
    onProfileRequest?: BlizzardProfileRequestObserver,
    waitForSlot?: BlizzardSlotWait
  ): Promise<readonly CompletedAchievement[]> {
    const validKey = validCharacterKey(key);
    return request(
      achievementsUrl(validKey),
      completedAchievementsFromResponse,
      signal,
      onProfileRequest,
      waitForSlot
    );
  }

  return {
    getGuildRoster,
    getGuildRosterByIdentity,
    getAchievementFingerprint,
    getCompletedAchievements
  };
}
