import type {
  CharacterRaiderIoFirstKillInput,
  RaiderIoLoggedEncounterAnswers,
  RaiderIoLoggedEncounterInput,
  RaiderIoLoggedEncounterUnavailableCode,
  RaiderIoLoggedEncounterUnavailableInput,
  StoredRaiderIoLoggedEncounter,
  StoredRaiderIoLoggedEncounterAnswers
} from "@slashwho/database";
import {
  lookupRaidEncounterByRaiderIoSlugs,
  matchesRaiderIoKill,
  supportedRegions,
  type CharacterKey
} from "@slashwho/domain";
import type {
  HistoricMythicKill,
  LoggedEncounter,
  MythicBossRanking,
  MythicBossRankingsOptions,
  RaiderIoEvidenceLimitation,
  RaiderIoGateway
} from "@slashwho/raiderio";

import { createConcurrencyLimiter } from "./concurrency";
import {
  historicWorldRankForKill,
  raiderIoRankingRequest,
  rankingRequestKey
} from "./historic-world-rank";

/** The same bounds as `raiderio_rankings`: 50 reads a run, four at a time. */
export const MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN = 50;
export const RAIDER_IO_LOGGED_ENCOUNTER_CONCURRENCY = 4;
/** World-rank lookups for first kills no Warcraft Logs kill matches. */
export const MAX_RAIDER_IO_FIRST_KILL_RANK_REQUESTS_PER_RUN = 50;

const dayMs = 24 * 60 * 60 * 1_000;
/**
 * A roster read as hidden is read again after a week: a guild can open its
 * compositions after the kill. A visible roster is never read again, because
 * the kill and who was in it do not change.
 */
export const RAIDER_IO_PRIVATE_ROSTER_REREAD_MS = 7 * dayMs;
/**
 * A permanent refusal is asked again after 30 days, in case the log was
 * restored or re-uploaded. Until then it costs nothing and fills no cap.
 */
export const RAIDER_IO_UNAVAILABLE_ENCOUNTER_REREAD_MS = 30 * dayMs;

export type RaiderIoFirstKillLimitation = Readonly<{
  code: RaiderIoEvidenceLimitation;
  retryAfterMs?: number;
}>;

export type RaiderIoFirstKillCollection = Readonly<{
  kills: readonly CharacterRaiderIoFirstKillInput[];
  /** Every read encounter the kills name that is now stored, read or held before. */
  encounters: ReadonlyMap<number, RaiderIoLoggedEncounterInput>;
  /** Why the phase fell short, or null. Only work a retry can finish counts. */
  limitation: RaiderIoFirstKillLimitation | null;
}>;

// A deleted log (`not_found`), a 403 (`private`) or one that names another
// boss (`schema_drift`) answers the same way every time: it is stored as an
// unavailable row and marks that kill's encounter unavailable, without
// holding the run partial.
function isPermanent(
  code: RaiderIoEvidenceLimitation
): code is RaiderIoLoggedEncounterUnavailableCode {
  return code === "not_found" || code === "private" || code === "schema_drift";
}

type Guild = CharacterRaiderIoFirstKillInput["guild"];

function encounterInput(
  loggedEncounterId: number,
  encounter: LoggedEncounter
): RaiderIoLoggedEncounterInput {
  return {
    loggedEncounterId,
    raidSlug: encounter.raidSlug,
    bossSlug: encounter.bossSlug,
    pulledAt: encounter.pulledAt,
    defeatedAt: encounter.defeatedAt,
    durationMs: encounter.durationMs,
    guild: encounter.guild ? { ...encounter.guild } : null,
    itemLevel: { ...encounter.itemLevel },
    deathCount: encounter.deathCount,
    vantusCount: encounter.vantusCount,
    rosterState:
      encounter.roster.state === "available" ? "available" : "private",
    members:
      encounter.roster.state === "available"
        ? encounter.roster.members.map((member) => ({ ...member }))
        : []
  };
}

function withoutReadAt(
  encounter: StoredRaiderIoLoggedEncounter
): RaiderIoLoggedEncounterInput {
  const { readAt, ...rest } = encounter;
  void readAt;
  return rest;
}

/**
 * Reads the logged encounter of every Raider.IO first kill that has one
 * (#732), and says which kills are the character's.
 *
 * What is stored decides what is read. A visible roster is never read again;
 * a hidden one is read again once a week old; a permanent refusal is asked
 * again once 30 days old. First reads come before re-reads, and all of them
 * share one bound, as `raiderio_rankings` does: 50 a run, four at a time, and
 * a read that throws abandons the rest. A kill counts as the character's only
 * when the roster holds the character's own Raider.IO id; where the roster is
 * hidden, Raider.IO's own attribution of the kill stands in for it.
 */
export async function collectRaiderIoFirstKills(
  input: Readonly<{
    key: CharacterKey;
    kills: readonly HistoricMythicKill[];
    /** The character's stored first kills: a `read` one has already passed its presence check. */
    published: readonly CharacterRaiderIoFirstKillInput[];
    storedEncounters: (
      ids: readonly number[]
    ) => Promise<StoredRaiderIoLoggedEncounterAnswers>;
    saveAnswers: (answers: RaiderIoLoggedEncounterAnswers) => Promise<void>;
    raiderio: Pick<RaiderIoGateway, "getLoggedEncounter"> &
      Partial<Pick<RaiderIoGateway, "getCharacter">>;
    signal: AbortSignal;
    now: () => Date;
    /** Called once per logged-encounter request actually sent. */
    onEncounterRequest?: () => void;
    /** Called once for the character read, if one is made. */
    onCharacterRequest?: () => void;
  }>
): Promise<RaiderIoFirstKillCollection> {
  const killById = new Map<number, HistoricMythicKill>();
  for (const kill of input.kills) {
    if (kill.loggedEncounterId != null)
      killById.set(kill.loggedEncounterId, kill);
  }
  const ids = [...killById.keys()];
  const stored: StoredRaiderIoLoggedEncounterAnswers =
    ids.length === 0
      ? { encounters: [], unavailable: [] }
      : await input.storedEncounters(ids);
  const at = input.now().getTime();

  const encounters = new Map<number, RaiderIoLoggedEncounterInput>();
  const storedRead = new Map<number, RaiderIoLoggedEncounterInput>();
  const storedUnavailable = new Map<
    number,
    RaiderIoLoggedEncounterUnavailableCode
  >();
  const due = new Set<number>();
  for (const encounter of stored.encounters) {
    const kept = withoutReadAt(encounter);
    encounters.set(encounter.loggedEncounterId, kept);
    storedRead.set(encounter.loggedEncounterId, kept);
    if (
      encounter.rosterState === "private" &&
      at - Date.parse(encounter.readAt) > RAIDER_IO_PRIVATE_ROSTER_REREAD_MS
    ) {
      due.add(encounter.loggedEncounterId);
    }
  }
  for (const answer of stored.unavailable) {
    storedUnavailable.set(answer.loggedEncounterId, answer.code);
    if (
      at - Date.parse(answer.readAt) >
      RAIDER_IO_UNAVAILABLE_ENCOUNTER_REREAD_MS
    ) {
      due.add(answer.loggedEncounterId);
    }
  }
  const held = (id: number) => encounters.has(id) || storedUnavailable.has(id);
  const unread = ids.filter((id) => !held(id));
  // A re-read already has an answer to show, so first reads go first. A
  // re-read the cap leaves out keeps its answer and limits nothing.
  const toRead = [...unread, ...ids.filter((id) => due.has(id))].slice(
    0,
    MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN
  );
  // This run's answer for an id no stored answer covers, or a fresh
  // permanent refusal, which replaces a stored one.
  const answered = new Map<number, RaiderIoEvidenceLimitation>(
    unread
      .slice(MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN)
      .map((id) => [id, "request_cap"] as const)
  );
  let limitation: RaiderIoFirstKillLimitation | null =
    unread.length > MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN
      ? { code: "request_cap" }
      : null;
  const fallShort = (next: RaiderIoFirstKillLimitation) => {
    limitation ??= next;
  };
  // A retryable miss matters only where nothing stored answers the id.
  const miss = (id: number, code: RaiderIoEvidenceLimitation) => {
    if (!held(id)) answered.set(id, code);
  };

  const limiter = createConcurrencyLimiter(
    RAIDER_IO_LOGGED_ENCOUNTER_CONCURRENCY
  );
  let abandoned = false;
  const readNow: RaiderIoLoggedEncounterInput[] = [];
  const unavailableNow: RaiderIoLoggedEncounterUnavailableInput[] = [];
  const refuse = (id: number, code: RaiderIoLoggedEncounterUnavailableCode) => {
    const kept = storedRead.get(id);
    if (kept) {
      // A read is never unread. Saved again unchanged, the hidden roster's
      // `read_at` moves on and it is not asked about again for a week.
      readNow.push(kept);
      return;
    }
    answered.set(id, code);
    unavailableNow.push({ loggedEncounterId: id, code });
  };
  await Promise.all(
    toRead.map((id) =>
      limiter.run(async () => {
        if (abandoned) {
          miss(id, "unavailable");
          return;
        }
        const kill = killById.get(id)!;
        try {
          const result = await input.raiderio.getLoggedEncounter(
            kill.raidSlug,
            id,
            input.signal,
            input.onEncounterRequest
          );
          if (result.kind === "limitation") {
            if (isPermanent(result.code)) {
              refuse(id, result.code);
              return;
            }
            miss(id, result.code);
            fallShort({
              code: result.code,
              ...(result.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: result.retryAfterMs })
            });
            return;
          }
          if (
            result.raidSlug !== kill.raidSlug ||
            result.bossSlug !== kill.bossSlug
          ) {
            // The log names another boss than the kill it was listed under.
            refuse(id, "schema_drift");
            return;
          }
          readNow.push(encounterInput(id, result));
        } catch (error) {
          if (input.signal.aborted) throw error;
          abandoned = true;
          miss(id, "unavailable");
          fallShort({ code: "unavailable" });
        }
      })
    )
  );

  if (readNow.length > 0 || unavailableNow.length > 0) {
    try {
      await input.saveAnswers({
        encounters: readNow,
        unavailable: unavailableNow
      });
      for (const encounter of readNow) {
        encounters.set(encounter.loggedEncounterId, encounter);
      }
    } catch {
      // Unsaved, a new read would name an encounter no reader can find. A
      // stored answer stands; a refusal is still this run's true answer.
      for (const encounter of readNow) {
        miss(encounter.loggedEncounterId, "unavailable");
      }
      fallShort({ code: "unavailable" });
    }
  }

  // Presence is established only where it was checked: a published read kill
  // whose stored roster was already visible before this run. One accepted
  // behind a hidden roster was never checked, so once a re-read opens the
  // roster it is checked like any new read.
  const visibleBefore = new Set(
    stored.encounters.flatMap((encounter) =>
      encounter.rosterState === "available" ? [encounter.loggedEncounterId] : []
    )
  );
  const established = new Set(
    input.published.flatMap((kill) =>
      kill.encounterState === "read" &&
      kill.loggedEncounterId !== null &&
      visibleBefore.has(kill.loggedEncounterId)
        ? [kill.loggedEncounterId]
        : []
    )
  );
  const needsPresenceCheck = [...encounters.values()].some(
    (encounter) =>
      encounter.rosterState === "available" &&
      !established.has(encounter.loggedEncounterId)
  );
  const characterId = needsPresenceCheck
    ? await raiderIoCharacterId(input)
    : null;
  if (needsPresenceCheck && characterId === null) {
    fallShort({ code: "unavailable" });
  }

  const kills = input.kills.flatMap(
    (kill): CharacterRaiderIoFirstKillInput[] => {
      const base = {
        raidSlug: kill.raidSlug,
        bossSlug: kill.bossSlug,
        guild: (kill.guild ? { ...kill.guild } : null) satisfies Guild,
        historicWorldRank: null,
        historicRankCheckedAt: null
      };
      const id = kill.loggedEncounterId ?? null;
      if (id === null) {
        return [
          {
            ...base,
            killedAt: kill.firstDefeated,
            loggedEncounterId: null,
            encounterState: "unavailable",
            encounterLimitationCode: null
          }
        ];
      }
      const encounter = encounters.get(id);
      if (!encounter) {
        return [
          {
            ...base,
            killedAt: kill.firstDefeated,
            loggedEncounterId: id,
            encounterState: "unavailable",
            encounterLimitationCode:
              answered.get(id) ?? storedUnavailable.get(id) ?? "unavailable"
          }
        ];
      }
      if (encounter.rosterState === "available" && !established.has(id)) {
        // Where the id could not be learned the kill waits for a run that
        // can; the run is partial, so nothing stored is dropped meanwhile.
        if (characterId === null) return [];
        if (
          !encounter.members.some(
            (member) => member.raiderIoCharacterId === characterId
          )
        ) {
          return [];
        }
      }
      return [
        {
          ...base,
          killedAt: encounter.defeatedAt,
          loggedEncounterId: id,
          encounterState: "read",
          encounterLimitationCode: null
        }
      ];
    }
  );

  return { kills, encounters, limitation };
}

async function raiderIoCharacterId(
  input: Readonly<{
    key: CharacterKey;
    raiderio: Partial<Pick<RaiderIoGateway, "getCharacter">>;
    signal: AbortSignal;
    onCharacterRequest?: () => void;
  }>
): Promise<number | null> {
  if (!input.raiderio.getCharacter) return null;
  try {
    input.onCharacterRequest?.();
    const character = await input.raiderio.getCharacter(
      input.key,
      input.signal
    );
    return character.raiderIoCharacterId ?? null;
  } catch (error) {
    if (input.signal.aborted) throw error;
    return null;
  }
}

const rankKey = (
  kill: Pick<
    CharacterRaiderIoFirstKillInput,
    "raidSlug" | "bossSlug" | "loggedEncounterId"
  >
) => `${kill.raidSlug}\0${kill.bossSlug}\0${String(kill.loggedEncounterId)}`;

function rankable(
  kill: CharacterRaiderIoFirstKillInput,
  encounters: ReadonlyMap<number, RaiderIoLoggedEncounterInput>
) {
  // Only a kill whose log was read stands as a kill event of its own, so only
  // it is worth a rank request; its guild is the encounter's own.
  if (kill.encounterState !== "read" || kill.loggedEncounterId === null)
    return null;
  const guild = encounters.get(kill.loggedEncounterId)?.guild;
  if (!guild) return null;
  const region = guild.region as CharacterKey["region"];
  if (!supportedRegions.includes(region)) return null;
  const catalogued = lookupRaidEncounterByRaiderIoSlugs(
    kill.raidSlug,
    kill.bossSlug
  );
  if (!catalogued) return null;
  const rankableKill = {
    raidName: catalogued.raidName,
    bossName: catalogued.bossName,
    killedAt: kill.killedAt,
    guild: { name: guild.name, realm: guild.realm }
  };
  const request = raiderIoRankingRequest(rankableKill, region);
  return request ? { rankableKill, region, request } : null;
}

/**
 * World ranks for read first kills no Warcraft Logs kill matches, from the
 * encounter's guild and exact defeat time through `historicWorldRankForKill`.
 * A guild's first kill gets its rank and a later kill with the same guild gets
 * none. A matched kill keeps the Warcraft Logs lookup it already has. A rank
 * once checked is kept with its check time, a null rank included, and never
 * asked about again. Never limits the phase: a lookup that fails is simply
 * made again next run.
 */
export async function rankRaiderIoFirstKills(
  input: Readonly<{
    kills: readonly CharacterRaiderIoFirstKillInput[];
    encounters: ReadonlyMap<number, RaiderIoLoggedEncounterInput>;
    warcraftLogsKills: readonly Readonly<{
      raidName: string;
      bossName?: string;
      killedAt: string;
    }>[];
    published: readonly CharacterRaiderIoFirstKillInput[];
    raiderio: Pick<RaiderIoGateway, "getMythicBossRankings">;
    signal: AbortSignal;
    now: () => Date;
    onPhysicalRequest?: () => void;
  }>
): Promise<readonly CharacterRaiderIoFirstKillInput[]> {
  const checked = new Map(
    input.published
      .filter((kill) => kill.historicRankCheckedAt !== null)
      .map((kill) => [rankKey(kill), kill] as const)
  );
  const candidates = input.kills.flatMap((kill) => {
    if (checked.has(rankKey(kill))) return [];
    if (
      input.warcraftLogsKills.some((stored) =>
        matchesRaiderIoKill(kill, stored)
      )
    )
      return [];
    const found = rankable(kill, input.encounters);
    return found ? [{ kill, ...found }] : [];
  });
  const requests = new Map<string, MythicBossRankingsOptions>();
  for (const candidate of candidates) {
    requests.set(rankingRequestKey(candidate.request), candidate.request);
  }
  const results = new Map<string, readonly MythicBossRanking[]>();
  const limiter = createConcurrencyLimiter(
    RAIDER_IO_LOGGED_ENCOUNTER_CONCURRENCY
  );
  let abandoned = false;
  await Promise.all(
    [...requests]
      .slice(0, MAX_RAIDER_IO_FIRST_KILL_RANK_REQUESTS_PER_RUN)
      .map(([requestKey, request]) =>
        limiter.run(async () => {
          if (abandoned) return;
          try {
            const result = await input.raiderio.getMythicBossRankings(
              request,
              input.signal,
              input.onPhysicalRequest
            );
            if (result.kind === "rankings")
              results.set(requestKey, result.rows);
          } catch (error) {
            if (input.signal.aborted) throw error;
            abandoned = true;
          }
        })
      )
  );
  const checkedAt = input.now().toISOString();
  const ranks = new Map<CharacterRaiderIoFirstKillInput, number | null>();
  for (const candidate of candidates) {
    const rows = results.get(rankingRequestKey(candidate.request));
    if (rows) {
      ranks.set(
        candidate.kill,
        historicWorldRankForKill(candidate.rankableKill, candidate.region, rows)
      );
    }
  }
  return input.kills.map((kill) => {
    const before = checked.get(rankKey(kill));
    if (before) {
      return {
        ...kill,
        historicWorldRank: before.historicWorldRank,
        historicRankCheckedAt: before.historicRankCheckedAt
      };
    }
    return ranks.has(kill)
      ? {
          ...kill,
          historicWorldRank: ranks.get(kill)!,
          historicRankCheckedAt: checkedAt
        }
      : kill;
  });
}
