import {
  isRosterShown,
  isValidCharacterKey,
  type CharacterKey
} from "@slashwho/domain";
import {
  classifyResponse,
  createUpstreamError,
  isUpstreamFailure,
  type ThrottleObserver,
  type UpstreamError,
  type UpstreamFailure
} from "@slashwho/upstream-http";
import { z } from "zod";

import {
  normalizeCharacterResponse,
  normalizeProfileResponse
} from "./normalize";
import type {
  RaiderIoCharacter,
  HistoricMythicKill,
  HistoricMythicKillOptions,
  HistoricMythicKillResult,
  LoggedEncounter,
  LoggedEncounterResult,
  MythicBossRanking,
  MythicBossRankingsOptions,
  MythicBossRankingsResult,
  RaiderIoEvidenceLimitation,
  RaiderIoPhysicalRequestObserver,
  RaiderIoGateway,
  RaiderIoProfile
} from "./types";

/**
 * The `raid-progress` tiers that hold every Raider.IO raid from Legion
 * onwards, recorded by sweeping tiers 0-45 on 2026-09-23. Pinned rather than
 * probed because Raider.IO answers an unknown tier with the current raid
 * instead of an error. Current raids ride along on every tier's response, so
 * a tier added after this list still arrives.
 *
 * Each tier names the raids it answers for, so a caller can tell which tiers
 * can no longer hold anything it wants (#298). Recorded on 2026-09-26 from the
 * `raid` slugs of live responses across a veteran guild's roster; a tier
 * returns only raids the character has an entry in, so each was confirmed on
 * a character who had raided it. Sporefall was released into the last tier
 * and was not seen on anyone swept; that tier is asked on every run anyway.
 */
export const raiderIoHistoricTiers: readonly Readonly<{
  ordinal: number;
  raidSlugs: readonly string[];
}>[] = Object.freeze(
  (
    [
      [19, ["the-emerald-nightmare", "the-nighthold", "trial-of-valor"]],
      [20, ["tomb-of-sargeras"]],
      [21, ["antorus-the-burning-throne"]],
      [22, ["uldir"]],
      [23, ["battle-of-dazaralor", "crucible-of-storms"]],
      [24, ["the-eternal-palace"]],
      [25, ["nyalotha-the-waking-city"]],
      [26, ["castle-nathria"]],
      [27, ["sanctum-of-domination"]],
      [28, ["sepulcher-of-the-first-ones"]],
      [29, ["vault-of-the-incarnates"]],
      [30, ["aberrus-the-shadowed-crucible"]],
      [31, ["amirdrassil-the-dreams-hope"]],
      [32, ["nerubar-palace"]],
      [33, ["liberation-of-undermine"]],
      [34, ["manaforge-omega"]],
      [35, ["tier-mn-1"]]
    ] as const
  ).map(([ordinal, raidSlugs]) =>
    Object.freeze({ ordinal, raidSlugs: Object.freeze([...raidSlugs]) })
  )
);

export const raiderIoHistoricTierOrdinals: readonly number[] = Object.freeze(
  raiderIoHistoricTiers.map((tier) => tier.ordinal)
);

export const maximumHistoricMythicKillTiers =
  raiderIoHistoricTierOrdinals.length;

// How many historic tiers are asked at once. Small, because the endpoint is
// undocumented and this client has no rate limiter of its own: it only reports
// throttling once Raider.IO has already applied it.
const historicMythicKillTierConcurrency = 3;

/**
 * What this client calls itself upstream. Raider.IO rejects requests without
 * an identifying agent, which
 * `scripts/generate-raid-current-content-windows.mts` has always known and the
 * client that runs in production did not (#356). It names the service, not a
 * browser: the point is to be identifiable, not to look like someone else.
 */
const RAIDER_IO_USER_AGENT = "SlashWho (+https://github.com/Erilla/SlashWho)";

// The recorded shape (2026-09-23): `raid` is a bare slug, and an encounter
// carries no name, ordinal or final-boss flag. The shape this replaced was
// guessed, and every live response failed it as schema drift.
const historicRaidProgressResponseSchema = z.object({
  characterRaidProgress: z.object({
    raidProgress: z.array(
      z.object({
        raid: z.string().min(1),
        encountersDefeated: z.object({
          mythic: z.array(
            z.object({
              slug: z.string().min(1),
              firstDefeated: z.string().datetime(),
              loggedEncounterId: z
                .number()
                .int()
                .positive()
                .nullable()
                .optional(),
              guild: z
                .object({
                  name: z.string().min(1),
                  realm: z.object({ slug: z.string().min(1) }),
                  region: z.object({ slug: z.string().min(1) })
                })
                .nullable()
                .optional()
            })
          )
        })
      })
    )
  })
});

const bossRankingsResponseSchema = z.object({
  bossRankings: z.array(
    z.object({
      rank: z.number().int().positive(),
      guild: z.object({
        name: z.string().min(1),
        realm: z.object({ slug: z.string().min(1) }),
        region: z.object({ slug: z.string().min(1) })
      }),
      encountersDefeated: z.array(
        z.object({
          slug: z.string().min(1),
          firstDefeated: z.string().datetime()
        })
      )
    })
  )
});

const guildBossRanksSchema = z.object({
  bossRankings: z.array(
    z.object({
      boss: z.string().min(1),
      ranks: z.object({ world: z.number().int().nonnegative() })
    })
  )
});
const guildEncountersSchema = z.object({
  name: z.string().min(1),
  realm: z.string().min(1),
  region: z.string().min(1),
  raid_encounters: z.array(
    z.object({
      slug: z.string().min(1),
      defeatedAt: z.string().datetime().nullable()
    })
  )
});

// Recorded 2026-09-28. Only these fields are read. `log.sources` names the
// uploader's Raider.IO account, which can be a BattleTag or a Discord handle,
// so the schema never names it and zod strips it with everything else.
const loggedEncounterResponseSchema = z.object({
  killDetails: z.object({
    kill: z.object({
      pulledAt: z.string().datetime(),
      defeatedAt: z.string().datetime(),
      durationMs: z.number().int().nonnegative(),
      isSuccess: z.boolean(),
      itemLevelEquippedAvg: z.number().nonnegative(),
      itemLevelEquippedMax: z.number().nonnegative(),
      itemLevelEquippedMin: z.number().nonnegative()
    }),
    log: z.object({
      deaths: z.object({ count: z.number().int().nonnegative() }),
      vantus: z.object({ count: z.number().int().nonnegative() })
    }),
    raid: z.object({ slug: z.string().min(1), difficulty: z.string().min(1) }),
    boss: z.object({ slug: z.string().min(1) }),
    guild: z
      .object({
        name: z.string().min(1),
        realm: z.object({ slug: z.string().min(1) }),
        region: z.object({ slug: z.string().min(1) })
      })
      .nullable()
      .optional(),
    guildPrivacy: z
      .object({
        raidComps: z.boolean(),
        // Until when the guild shares its raids; a roster read as visible is
        // read again once it has passed, in case the guild has since hidden
        // it. Read leniently: an unreadable end is no end, never a refusal of
        // the kill.
        shareRaidUntil: z.string().nullable().optional()
      })
      .nullable()
      .optional(),
    roster: z
      .array(
        z.object({
          character: z.object({
            id: z.number().int().positive(),
            name: z.string().min(1),
            class: z.object({ name: z.string().min(1) }),
            spec: z.object({
              name: z.string().min(1),
              role: z.enum(["tank", "healer", "dps"])
            }),
            itemLevelEquipped: z.number().nonnegative().nullable().optional(),
            realm: z.object({ slug: z.string().min(1) }),
            region: z.object({ slug: z.string().min(1) })
          })
        })
      )
      .optional()
  })
});

const lowerCase = (value: string) => value.toLocaleLowerCase("en-US");

/**
 * A roster member's realm as every character key spells it: lower case with
 * the accents dropped, as `parseCharacterPath` folds a Raider.IO URL
 * ("aggra-português" is "aggra-portugues"). A suppression is keyed the same
 * way, so a removed raider is recognised on another character's roster.
 */
const memberRealm = (value: string) =>
  lowerCase(value).normalize("NFD").replace(/\p{M}/gu, "");

function instantOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function normalizeLoggedEncounter(value: unknown): LoggedEncounter {
  const { killDetails } = loggedEncounterResponseSchema.parse(value);
  // A first kill's log is a successful Mythic pull. Anything else is not the
  // kill the character's list named, and is refused as drift.
  if (!killDetails.kill.isSuccess || killDetails.raid.difficulty !== "mythic") {
    throw new Error("logged_encounter_not_a_mythic_kill");
  }
  const roster = killDetails.roster ?? [];
  const hidden = !isRosterShown(killDetails.guildPrivacy?.raidComps, roster);
  return {
    kind: "encounter",
    raidSlug: killDetails.raid.slug,
    bossSlug: killDetails.boss.slug,
    pulledAt: killDetails.kill.pulledAt,
    defeatedAt: killDetails.kill.defeatedAt,
    durationMs: killDetails.kill.durationMs,
    itemLevel: {
      average: killDetails.kill.itemLevelEquippedAvg,
      min: killDetails.kill.itemLevelEquippedMin,
      max: killDetails.kill.itemLevelEquippedMax
    },
    guild: killDetails.guild
      ? {
          name: killDetails.guild.name,
          realm: lowerCase(killDetails.guild.realm.slug),
          region: lowerCase(killDetails.guild.region.slug)
        }
      : null,
    deathCount: killDetails.log.deaths.count,
    vantusCount: killDetails.log.vantus.count,
    shareRaidUntil: instantOrNull(killDetails.guildPrivacy?.shareRaidUntil),
    roster: hidden
      ? { state: "unavailable", reason: "private" }
      : {
          state: "available",
          members: roster.map(({ character }) => ({
            raiderIoCharacterId: character.id,
            name: character.name,
            realm: memberRealm(character.realm.slug),
            region: lowerCase(character.region.slug),
            className: character.class.name,
            specName: character.spec.name,
            role: character.spec.role,
            itemLevel: character.itemLevelEquipped ?? null
          }))
        }
  };
}

export type CreateRaiderIoClientOptions = {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  timeoutMs: number;
  accessKey?: string | undefined;
  onThrottle?: ThrottleObserver;
};

function createRaiderIoError(failure: UpstreamFailure): UpstreamError {
  return createUpstreamError("raiderio", failure);
}

function reportPhysicalRequest(
  observer: RaiderIoPhysicalRequestObserver | undefined
): void {
  try {
    observer?.();
  } catch {
    // Measurement cannot change an upstream result.
  }
}

function validatedCharacterKey(key: CharacterKey): CharacterKey {
  if (!isValidCharacterKey(key)) throw new Error("invalid_character_key");
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
        raidSlug: raidProgress.raid,
        bossSlug: encounter.slug,
        firstDefeated: encounter.firstDefeated,
        guild: encounter.guild
          ? {
              name: encounter.guild.name,
              realm: encounter.guild.realm.slug,
              region: encounter.guild.region.slug.toLocaleLowerCase("en-US")
            }
          : null,
        loggedEncounterId: encounter.loggedEncounterId ?? null
      });
    }
  }

  return kills;
}

type RaiderIoLimitationResult = Readonly<{
  kind: "limitation";
  code: RaiderIoEvidenceLimitation;
  retryAfterMs?: number;
}>;

/**
 * An upstream failure as a limitation, for every evidence method: the kill
 * list, the boss rankings and a logged encounter answer failures alike.
 */
function raiderIoLimitation(error: unknown): RaiderIoLimitationResult {
  if (!isUpstreamFailure(error)) {
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

function normalizeBossRankings(
  value: unknown,
  bossSlug: string
): readonly MythicBossRanking[] {
  const parsed = bossRankingsResponseSchema.parse(value);
  return parsed.bossRankings.flatMap((row) => {
    // Rows include duplicate recordings and later kills. Only the guild's
    // earliest defeat of the requested boss carries this progression rank.
    const encounter = row.encountersDefeated
      .filter((entry) => entry.slug === bossSlug)
      .sort(
        (a, b) => Date.parse(a.firstDefeated) - Date.parse(b.firstDefeated)
      )[0];
    if (!encounter) return [];
    return [
      {
        rank: row.rank,
        guildName: row.guild.name,
        guildRealm: row.guild.realm.slug,
        guildRegion: row.guild.region.slug,
        firstDefeated: encounter.firstDefeated
      }
    ];
  });
}

function boundedTierOrdinals(
  options: HistoricMythicKillOptions
): readonly number[] | null {
  const tiers = [...new Set(options.tierOrdinals)];
  if (
    tiers.length > maximumHistoricMythicKillTiers ||
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
    signal?: AbortSignal,
    onPhysicalRequest?: RaiderIoPhysicalRequestObserver
  ): Promise<T> {
    // A copy, so the caller's URL never carries the key: a URL holding it
    // must never be logged, and the caller cannot know it had been added.
    if (options.accessKey && url.pathname.startsWith("/api/v1/")) {
      url = new URL(url);
      url.searchParams.set("access_key", options.accessKey);
    }
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      reportPhysicalRequest(onPhysicalRequest);
      response = await options.fetch(url, {
        headers: {
          Accept: "application/json",
          // Raider.IO sits behind Cloudflare bot detection, which refuses a
          // request carrying no agent with "Error 1010: Access denied" (#356).
          // That arrives as a 403 -- indistinguishable here from an ordinary
          // lookup failure -- so discovery spent its whole retry chain on
          // instant refusals and failed terminally. The access key makes no
          // difference; this is not authentication.
          "user-agent": RAIDER_IO_USER_AGENT
        },
        signal: requestSignal
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw createRaiderIoError({ kind: "transient" });
    }

    signal?.throwIfAborted();
    if (!response.ok) {
      // Raider.IO answers 403 for a user profile its owner has made private.
      // That is a permanent answer about visibility, not an outage, so it is
      // never retried as one, and it never fires onThrottle.
      throw createRaiderIoError(classifyResponse(response, options.onThrottle));
    }

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
        isUpstreamFailure(error) &&
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
    const requestCap = options.requestCap ?? maximumHistoricMythicKillTiers;
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
    // Tiers are asked a few at a time rather than one after another: a full
    // run with no settled history asks for all of them, so a serial walk made
    // each run wait on seventeen round trips. The result is still what a
    // serial walk would give. Tiers start in order and none starts after a
    // failure, so every tier below the earliest failure has been answered,
    // and that failure is the limitation reported. Kills merge in tier order,
    // so an overlapping duplicate resolves exactly as before.
    const outcomes: Array<
      | { kind: "kills"; kills: readonly HistoricMythicKill[] }
      | { kind: "failed"; error: unknown }
      | undefined
    > = [];
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < tiers.length) {
        const index = next;
        next += 1;
        const url = new URL(`/${path}`, baseUrl);
        url.searchParams.set("tier", String(tiers[index]));
        try {
          outcomes[index] = {
            kind: "kills",
            kills: await request(
              url,
              normalizeHistoricRaidProgress,
              options.signal,
              options.onPhysicalRequest
            )
          };
        } catch (error) {
          failed = true;
          outcomes[index] = { kind: "failed", error };
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(historicMythicKillTierConcurrency, tiers.length) },
        worker
      )
    );
    if (options.signal?.aborted) throw options.signal.reason;

    const earliestKills = new Map<string, HistoricMythicKill>();
    for (const outcome of outcomes) {
      // Tiers after a failure were never started.
      if (!outcome) break;
      if (outcome.kind === "failed") {
        return raiderIoLimitation(outcome.error);
      }

      for (const kill of outcome.kills) {
        const identifier = `${kill.raidSlug}\u0000${kill.bossSlug}`;
        const existing = earliestKills.get(identifier);
        if (!existing || kill.firstDefeated < existing.firstDefeated) {
          earliestKills.set(identifier, kill);
        }
      }
    }

    return { kind: "evidence", kills: [...earliestKills.values()] };
  }

  async function getMythicBossRankings(
    rankingOptions: MythicBossRankingsOptions,
    signal?: AbortSignal,
    onPhysicalRequest?: RaiderIoPhysicalRequestObserver
  ): Promise<MythicBossRankingsResult> {
    const raidSlug = rankingOptions.raidSlug;
    const bossSlug = rankingOptions.bossSlug;
    if (!raidSlug || !bossSlug) {
      return { kind: "limitation", code: "schema_drift" };
    }

    signal?.throwIfAborted();

    if (rankingOptions.guild) {
      const guild = rankingOptions.guild;
      const ranksUrl = new URL("/api/guilds/raid-rankings", baseUrl);
      ranksUrl.search = new URLSearchParams({
        region: guild.region,
        realm: guild.realm,
        guild: guild.name,
        raid: raidSlug,
        difficulty: "mythic"
      }).toString();
      const profileUrl = new URL("/api/v1/guilds/profile", baseUrl);
      profileUrl.search = new URLSearchParams({
        region: guild.region,
        realm: guild.realm,
        name: guild.name,
        fields: `raid_encounters:${raidSlug}:mythic`
      }).toString();
      try {
        const [ranks, profile] = await Promise.all([
          request(
            ranksUrl,
            (value) => guildBossRanksSchema.parse(value),
            signal,
            onPhysicalRequest
          ),
          request(
            profileUrl,
            (value) => guildEncountersSchema.parse(value),
            signal,
            onPhysicalRequest
          )
        ]);
        // The website also ranks unfinished attempts. A matching confirmed
        // first defeat is required before a rank can enrich kill evidence.
        const rows = ranks.bossRankings.flatMap((row) => {
          const defeats = profile.raid_encounters.filter(
            (kill) => kill.slug === row.boss && kill.defeatedAt
          );
          if (row.ranks.world <= 0 || defeats.length !== 1) return [];
          return [
            {
              bossSlug: row.boss,
              rank: row.ranks.world,
              guildName: profile.name,
              guildRealm: profile.realm,
              guildRegion: profile.region,
              firstDefeated: defeats[0]!.defeatedAt!
            }
          ];
        });
        return { kind: "rankings", rows };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        return raiderIoLimitation(error);
      }
    }

    const url = new URL("/api/v1/raiding/boss-rankings", baseUrl);
    url.search = new URLSearchParams({
      raid: raidSlug,
      boss: bossSlug,
      difficulty: "mythic",
      region: "world"
    }).toString();

    try {
      // The application owns the bounded, expiring ranking cache.
      const rows = await request(
        url,
        (value) => normalizeBossRankings(value, bossSlug),
        signal,
        onPhysicalRequest
      );
      return { kind: "rankings", rows };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return raiderIoLimitation(error);
    }
  }

  async function getLoggedEncounter(
    raidSlug: string,
    loggedEncounterId: number,
    signal?: AbortSignal,
    onPhysicalRequest?: RaiderIoPhysicalRequestObserver
  ): Promise<LoggedEncounterResult> {
    // Both go into the path, so neither may be anything but what Raider.IO
    // itself sends: a slug and a positive integer.
    if (
      !/^[a-z0-9-]+$/.test(raidSlug) ||
      !Number.isSafeInteger(loggedEncounterId) ||
      loggedEncounterId <= 0
    ) {
      return { kind: "limitation", code: "schema_drift" };
    }
    signal?.throwIfAborted();
    const url = new URL(
      `/api/raid/logged-encounters/${raidSlug}/${String(loggedEncounterId)}`,
      baseUrl
    );
    try {
      return await request(
        url,
        normalizeLoggedEncounter,
        signal,
        onPhysicalRequest
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return raiderIoLimitation(error);
    }
  }

  return {
    getCharacter,
    getClaimedCharacters,
    resolveProfileGuess,
    getHistoricMythicKills,
    getMythicBossRankings,
    getLoggedEncounter
  };
}
