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
 * compositions after the kill.
 */
export const RAIDER_IO_PRIVATE_ROSTER_REREAD_MS = 7 * dayMs;
/**
 * A roster read as visible is read again once the guild's `shareRaidUntil`
 * has passed, or, where Raider.IO named no end, after 30 days: a guild can
 * hide its compositions after the kill, and a hidden roster must stop being
 * shown. The kill itself is never read again.
 */
export const RAIDER_IO_VISIBLE_ROSTER_REREAD_MS = 30 * dayMs;
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
    shareRaidUntil: encounter.shareRaidUntil,
    rosterState:
      encounter.roster.state === "available" ? "available" : "private",
    members:
      encounter.roster.state === "available"
        ? encounter.roster.members.map((member) => ({ ...member }))
        : []
  };
}

/**
 * A re-read of a kill already stored: the kill stays as first read, and only
 * what the guild can change since, its roster and how long it shares it, is
 * taken from the new answer.
 */
function refreshed(
  kept: RaiderIoLoggedEncounterInput,
  read: RaiderIoLoggedEncounterInput
): RaiderIoLoggedEncounterInput {
  return {
    ...kept,
    shareRaidUntil: read.shareRaidUntil,
    rosterState: read.rosterState,
    members: read.members
  };
}

/**
 * Whether a stored visible roster is due a re-read. Once `shareRaidUntil` has
 * passed it is read once more; a read after that end that still finds the
 * roster visible (Raider.IO naming the same past end) waits the ordinary 30
 * days, so a stale end does not cost a read every run.
 */
function visibleRosterDue(
  encounter: StoredRaiderIoLoggedEncounter,
  at: number
): boolean {
  const readAt = Date.parse(encounter.readAt);
  if (encounter.shareRaidUntil !== null) {
    const until = Date.parse(encounter.shareRaidUntil);
    if (at <= until) return false;
    if (readAt <= until) return true;
  }
  return at - readAt > RAIDER_IO_VISIBLE_ROSTER_REREAD_MS;
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
 * What is stored decides what is read. A visible roster is read again once
 * the guild's `shareRaidUntil` has passed, or once 30 days old where there is
 * none, and turns private if the guild has since hidden it; a hidden one is
 * read again once a week old; a permanent refusal is asked again once 30 days
 * old. First reads come before re-reads, and all of them share one bound, as
 * `raiderio_rankings` does: 50 a run, four at a time, and a read that throws
 * or is rate limited abandons the rest. A kill counts as the character's only
 * once a visible roster held the character's own Raider.IO id, recorded on
 * the kill as `presenceChecked`; where the roster is hidden, Raider.IO's own
 * attribution of the kill stands in for it.
 */
export async function collectRaiderIoFirstKills(
  input: Readonly<{
    key: CharacterKey;
    kills: readonly HistoricMythicKill[];
    /** The character's stored first kills: a `read` one's `presenceChecked` says whether its presence check has already passed. */
    published: readonly CharacterRaiderIoFirstKillInput[];
    storedEncounters: (
      ids: readonly number[]
    ) => Promise<StoredRaiderIoLoggedEncounterAnswers>;
    saveAnswers: (answers: RaiderIoLoggedEncounterAnswers) => Promise<void>;
    raiderio: Pick<RaiderIoGateway, "getLoggedEncounter"> &
      Partial<Pick<RaiderIoGateway, "getCharacter">>;
    signal: AbortSignal;
    now: () => Date;
    /** Raids of tiers asked anyway; their due re-reads queue before the back catalogue's. */
    priorityRaidSlugs?: ReadonlySet<string>;
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
      encounter.rosterState === "private"
        ? at - Date.parse(encounter.readAt) > RAIDER_IO_PRIVATE_ROSTER_REREAD_MS
        : visibleRosterDue(encounter, at)
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
  const readAtById = new Map<number, number>([
    ...stored.encounters.map(
      (item) => [item.loggedEncounterId, Date.parse(item.readAt)] as const
    ),
    ...stored.unavailable.map(
      (item) => [item.loggedEncounterId, Date.parse(item.readAt)] as const
    )
  ]);
  const priority = (id: number) =>
    input.priorityRaidSlugs?.has(killById.get(id)!.raidSlug) ? 0 : 1;
  // A re-read already has an answer to show, so first reads go first. Among
  // re-reads, current raids first, then the oldest answer: a back catalogue
  // falling due at once must not crowd out rosters a recruiter is looking at
  // now.
  const dueIds = ids
    .filter((id) => due.has(id))
    .sort(
      (a, b) =>
        priority(a) - priority(b) ||
        readAtById.get(a)! - readAtById.get(b)! ||
        a - b
    );
  const toRead = [...unread, ...dueIds].slice(
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
  // Why the rest of the queue was abandoned, once a read throws or is rate
  // limited; every read not yet sent is missed for the same reason.
  let abandoned: "unavailable" | "rate_limited" | null = null;
  const readNow: RaiderIoLoggedEncounterInput[] = [];
  const unavailableNow: RaiderIoLoggedEncounterUnavailableInput[] = [];
  const refuse = (id: number, code: RaiderIoLoggedEncounterUnavailableCode) => {
    const kept = storedRead.get(id);
    if (kept) {
      // A read is never unread. A 403 hides its roster, as a guild hiding its
      // compositions does. Any other refusal changes nothing; saved again
      // unchanged, the row's `read_at` moves on and it is not asked about
      // again until due.
      readNow.push(
        code === "private"
          ? {
              ...kept,
              shareRaidUntil: null,
              rosterState: "private",
              members: []
            }
          : kept
      );
      return;
    }
    answered.set(id, code);
    unavailableNow.push({ loggedEncounterId: id, code });
  };
  await Promise.all(
    toRead.map((id) =>
      limiter.run(async () => {
        if (abandoned) {
          miss(id, abandoned);
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
            // A 429 says to stop asking: the rest of the queue is abandoned,
            // as after a read that throws.
            if (result.code === "rate_limited") abandoned ??= "rate_limited";
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
          const read = encounterInput(id, result);
          const kept = storedRead.get(id);
          readNow.push(kept ? refreshed(kept, read) : read);
        } catch (error) {
          if (input.signal.aborted) throw error;
          abandoned ??= "unavailable";
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

  // Presence is established only where it was checked and recorded on the
  // kill itself. Inferring it from "read, and the roster was visible before
  // this run" let a partial run that opened a roster carry an unchecked kill
  // past its check for good.
  const established = new Set(
    input.published.flatMap((kill) =>
      kill.encounterState === "read" &&
      kill.loggedEncounterId !== null &&
      kill.presenceChecked === true
        ? [kill.loggedEncounterId]
        : []
    )
  );
  const needsPresenceCheck = [...encounters.values()].some(
    (encounter) =>
      encounter.rosterState === "available" &&
      !established.has(encounter.loggedEncounterId)
  );
  const character = needsPresenceCheck
    ? await raiderIoCharacterId(input)
    : null;
  if (character?.kind === "failed") fallShort({ code: "unavailable" });

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
            encounterLimitationCode: null,
            presenceChecked: false
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
              answered.get(id) ?? storedUnavailable.get(id) ?? "unavailable",
            presenceChecked: false
          }
        ];
      }
      let presenceChecked = false;
      if (encounter.rosterState === "available") {
        if (established.has(id)) {
          presenceChecked = true;
        } else if (character?.kind === "id") {
          if (
            !encounter.members.some(
              (member) => member.raiderIoCharacterId === character.id
            )
          ) {
            return [];
          }
          presenceChecked = true;
        } else if (character?.kind !== "none") {
          // Where the id could not be learned the kill waits for a run that
          // can; the run is partial, so nothing stored is dropped meanwhile.
          return [];
        }
        // "none": accepted on Raider.IO's attribution, as behind a hidden
        // roster, and checked again on a later run.
      }
      return [
        {
          ...base,
          killedAt: encounter.defeatedAt,
          loggedEncounterId: id,
          encounterState: "read",
          encounterLimitationCode: null,
          presenceChecked
        }
      ];
    }
  );

  return { kills, encounters, limitation };
}

/**
 * The character's stored first kills in raids this run's kill list did not
 * ask about, as kill-list entries, so a settled tier's rosters keep being
 * re-read without asking for its kill list (#732 follow-up). Every one is
 * rebuilt, due or not: their raids join `askedRaidSlugs`, and a complete
 * publish keeps only what the run hands it.
 */
export function rebuildSettledFirstKills(
  published: readonly CharacterRaiderIoFirstKillInput[],
  askedRaidSlugs: readonly string[]
): HistoricMythicKill[] {
  const asked = new Set(askedRaidSlugs);
  return published
    .filter((kill) => !asked.has(kill.raidSlug))
    .map((kill) => ({
      raidSlug: kill.raidSlug,
      bossSlug: kill.bossSlug,
      firstDefeated: kill.killedAt,
      guild: kill.guild ? { ...kill.guild } : null,
      loggedEncounterId: kill.loggedEncounterId
    }));
}

type CharacterIdAnswer =
  | Readonly<{ kind: "id"; id: number }>
  // The read succeeded and Raider.IO gives the profile no id. That answer
  // does not change, so it is not a shortfall.
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "failed" }>;

async function raiderIoCharacterId(
  input: Readonly<{
    key: CharacterKey;
    raiderio: Partial<Pick<RaiderIoGateway, "getCharacter">>;
    signal: AbortSignal;
    onCharacterRequest?: () => void;
  }>
): Promise<CharacterIdAnswer> {
  if (!input.raiderio.getCharacter) return { kind: "failed" };
  try {
    input.onCharacterRequest?.();
    const character = await input.raiderio.getCharacter(
      input.key,
      input.signal
    );
    return character.raiderIoCharacterId == null
      ? { kind: "none" }
      : { kind: "id", id: character.raiderIoCharacterId };
  } catch (error) {
    if (input.signal.aborted) throw error;
    return { kind: "failed" };
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
