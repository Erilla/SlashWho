import type { CharacterKey } from "@slashwho/domain";
import { supportedRegions } from "@slashwho/domain";
import { z } from "zod";

import {
  createRaiderIoError,
  isRaiderIoFailure,
  type RaiderIoFailure
} from "./errors";
import {
  normalizeCharacterResponse,
  normalizeProfileResponse
} from "./normalize";
import type {
  RaiderIoCharacter,
  HistoricMythicKill,
  HistoricMythicKillOptions,
  HistoricMythicKillResult,
  RaiderIoGateway,
  RaiderIoProfile
} from "./types";

const MAX_HISTORIC_MYTHIC_KILL_TIERS = 8;

const historicRaidProgressResponseSchema = z.object({
  characterRaidProgress: z.object({
    raidProgress: z.array(
      z.object({
        raid: z.object({
          id: z.string().min(1),
          name: z.string().min(1)
        }),
        encountersDefeated: z.object({
          mythic: z.array(
            z.object({
              slug: z.string().min(1),
              name: z.string().min(1),
              ordinal: z.number().int().nonnegative(),
              isFinalBoss: z.boolean(),
              firstDefeated: z.string().datetime(),
              guild: z
                .object({
                  name: z.string().min(1),
                  realm: z.object({ slug: z.string().min(1) })
                })
                .nullable()
                .optional(),
              historicWorldRank: z
                .number()
                .int()
                .positive()
                .nullable()
                .optional()
            })
          )
        })
      })
    )
  })
});

export type CreateRaiderIoClientOptions = {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  timeoutMs: number;
};

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;

  if (/^\d+$/.test(value)) return Number(value) * 1000;

  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - Date.now());
}

function responseFailure(response: Response): RaiderIoFailure {
  if (response.status === 404) return { kind: "not_found" };
  // Raider.IO answers 403 for a user profile its owner has made private. That
  // is a permanent answer about visibility, not an outage, so it must never be
  // retried as one.
  if (response.status === 403) return { kind: "forbidden" };

  const retryAfter = retryAfterMs(response);
  return {
    kind: "transient",
    status: response.status,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter })
  };
}

function validatedCharacterKey(key: CharacterKey): CharacterKey {
  const valid =
    supportedRegions.includes(key.region) &&
    /^[a-z0-9-]+$/.test(key.realm) &&
    /^[\p{L}\p{M}'-]+$/u.test(key.name) &&
    key.realm === key.realm.toLocaleLowerCase("en-US") &&
    key.name === key.name.toLocaleLowerCase("en-US");

  if (!valid) throw new Error("invalid_character_key");
  return key;
}

function normalizeHistoricRaidProgress(
  value: unknown
): readonly HistoricMythicKill[] {
  const parsed = historicRaidProgressResponseSchema.parse(value);
  const kills: HistoricMythicKill[] = [];

  for (const raidProgress of parsed.characterRaidProgress.raidProgress) {
    for (const encounter of raidProgress.encountersDefeated.mythic) {
      kills.push({
        raidId: raidProgress.raid.id,
        raidName: raidProgress.raid.name,
        bossId: encounter.slug,
        bossName: encounter.name,
        bossOrder: encounter.ordinal,
        isFinalBoss: encounter.isFinalBoss,
        firstDefeated: encounter.firstDefeated,
        guild: encounter.guild
          ? {
              name: encounter.guild.name,
              realm: encounter.guild.realm.slug
            }
          : null,
        historicWorldRank: encounter.historicWorldRank ?? null
      });
    }
  }

  return kills;
}

function historicKillLimitation(error: unknown): HistoricMythicKillResult {
  if (!isRaiderIoFailure(error)) {
    return { kind: "limitation", code: "unavailable" };
  }

  switch (error.kind) {
    case "not_found":
      return { kind: "limitation", code: "not_found" };
    case "forbidden":
      return { kind: "limitation", code: "private" };
    case "schema_drift":
      return { kind: "limitation", code: "schema_drift" };
    case "transient":
      return {
        kind: "limitation",
        code: error.status === 429 ? "rate_limited" : "unavailable",
        ...(error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: error.retryAfterMs })
      };
  }
}

function boundedTierOrdinals(
  options: HistoricMythicKillOptions
): readonly number[] | null {
  const tiers = [...new Set(options.tierOrdinals)];
  if (
    tiers.length > MAX_HISTORIC_MYTHIC_KILL_TIERS ||
    tiers.some((tier) => !Number.isSafeInteger(tier) || tier < 0)
  ) {
    return null;
  }
  return tiers;
}

export function createRaiderIoClient(
  options: CreateRaiderIoClientOptions
): RaiderIoGateway {
  const baseUrl = new URL(options.baseUrl);
  if (!/^https?:$/.test(baseUrl.protocol)) throw new Error("invalid_base_url");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("invalid_timeout");
  }

  async function request<T>(
    url: URL,
    normalize: (value: unknown) => T,
    signal?: AbortSignal
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await options.fetch(url, {
        headers: { Accept: "application/json" },
        signal: requestSignal
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw createRaiderIoError({ kind: "transient" });
    }

    signal?.throwIfAborted();
    if (!response.ok) throw createRaiderIoError(responseFailure(response));

    let value: unknown;
    try {
      value = await response.json();
      signal?.throwIfAborted();
      return normalize(value);
    } catch {
      if (signal?.aborted) throw signal.reason;
      if (requestSignal.aborted) {
        throw createRaiderIoError({ kind: "transient" });
      }
      throw createRaiderIoError({ kind: "schema_drift" });
    }
  }

  function profileUrl(value: string): URL {
    const url = new URL("/api/user/view-characters", baseUrl);
    url.searchParams.set("name", value);
    return url;
  }

  async function getCharacter(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<RaiderIoCharacter> {
    const validKey = validatedCharacterKey(key);
    const path = [
      "api",
      "characters",
      validKey.region,
      validKey.realm,
      validKey.name
    ]
      .map(encodeURIComponent)
      .join("/");

    return request(
      new URL(`/${path}`, baseUrl),
      (value) => normalizeCharacterResponse(value, validKey),
      signal
    );
  }

  async function getClaimedCharacters(
    ownerId: string,
    signal?: AbortSignal
  ): Promise<RaiderIoProfile> {
    const profile = await request(
      profileUrl(ownerId),
      normalizeProfileResponse,
      signal
    );
    if (
      profile.validationName.toLocaleLowerCase("en-US") !==
      ownerId.toLocaleLowerCase("en-US")
    ) {
      throw createRaiderIoError({ kind: "schema_drift" });
    }
    return {
      characters: profile.characters,
      ...(profile.omittedMembers ? { omittedMembers: true } : {})
    };
  }

  async function resolveProfileGuess(
    value: string,
    signal?: AbortSignal
  ): Promise<RaiderIoProfile | null> {
    try {
      const profile = await request(
        profileUrl(value),
        normalizeProfileResponse,
        signal
      );
      if (
        profile.validationName.toLocaleLowerCase("en-US") !==
        value.toLocaleLowerCase("en-US")
      ) {
        return null;
      }
      return {
        characters: profile.characters,
        ...(profile.omittedMembers ? { omittedMembers: true } : {})
      };
    } catch (error) {
      if (
        isRaiderIoFailure(error) &&
        (error.kind === "not_found" || error.kind === "forbidden")
      ) {
        return null;
      }
      throw error;
    }
  }

  async function getHistoricMythicKills(
    key: CharacterKey,
    options: HistoricMythicKillOptions
  ): Promise<HistoricMythicKillResult> {
    const validKey = validatedCharacterKey(key);
    const tiers = boundedTierOrdinals(options);
    const requestCap = options.requestCap ?? MAX_HISTORIC_MYTHIC_KILL_TIERS;
    if (
      !tiers ||
      !Number.isSafeInteger(requestCap) ||
      requestCap < 0 ||
      tiers.length > requestCap
    ) {
      return { kind: "limitation", code: "request_cap" };
    }

    const path = [
      "api",
      "characters",
      validKey.region,
      validKey.realm,
      validKey.name,
      "raid-progress"
    ]
      .map(encodeURIComponent)
      .join("/");
    const earliestKills = new Map<string, HistoricMythicKill>();

    for (const tier of tiers) {
      const url = new URL(`/${path}`, baseUrl);
      url.searchParams.set("tier", String(tier));
      let kills: readonly HistoricMythicKill[];
      try {
        kills = await request(
          url,
          normalizeHistoricRaidProgress,
          options.signal
        );
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        return historicKillLimitation(error);
      }

      for (const kill of kills) {
        const identifier = `${kill.raidId}\u0000${kill.bossId}`;
        const existing = earliestKills.get(identifier);
        if (!existing || kill.firstDefeated < existing.firstDefeated) {
          earliestKills.set(identifier, kill);
        }
      }
    }

    return { kind: "evidence", kills: [...earliestKills.values()] };
  }

  return {
    getCharacter,
    getClaimedCharacters,
    resolveProfileGuess,
    getHistoricMythicKills
  };
}
