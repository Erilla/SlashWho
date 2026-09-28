import type {
  PublishedRaiderIoLoggedEncounter,
  StoredCharacterRaiderIoFirstKill
} from "@slashwho/database";
import {
  supportedRegions,
  type CharacterKey,
  type DossierKillEvidence,
  type DossierLoggedEncounter,
  type DossierRaiderIoFirstKill
} from "@slashwho/domain";

// Raider.IO's permanent refusals, the same three the collection phase stores
// as unavailable: a log it no longer has, one it refuses to show (403), and
// one that named another kill. None will ever be read, so the kill is as
// good as unlogged.
const PERMANENTLY_UNREAD: ReadonlySet<string> = new Set([
  "not_found",
  "private",
  "schema_drift"
]);

function dossierGuild(
  guild: Readonly<{ name: string; realm: string; region: string }> | null
): DossierKillEvidence["guild"] {
  if (!guild) return null;
  const region = guild.region.toLocaleLowerCase("en-US");
  return (supportedRegions as readonly string[]).includes(region)
    ? {
        name: guild.name,
        realm: guild.realm,
        region: region as CharacterKey["region"]
      }
    : null;
}

function dossierEncounter(
  encounter: PublishedRaiderIoLoggedEncounter
): DossierLoggedEncounter {
  return {
    pulledAt: encounter.pulledAt,
    defeatedAt: encounter.defeatedAt,
    durationMs: encounter.durationMs,
    guild: dossierGuild(encounter.guild),
    itemLevel: { ...encounter.itemLevel },
    deathCount: encounter.deathCount,
    vantusCount: encounter.vantusCount,
    // Raider.IO's own ids stop here: the contract has no place for them.
    // Whether what is left can be shown is the domain's `isRosterShown`.
    roster:
      encounter.rosterState === "available"
        ? {
            state: "available",
            roleCounts: { ...encounter.roleCounts },
            members: encounter.members.map((member) => ({
              name: member.name,
              realm: member.realm,
              region: member.region,
              className: member.className,
              specName: member.specName,
              role: member.role,
              itemLevel: member.itemLevel
            }))
          }
        : { state: "private" }
  };
}

/** A stored Raider.IO first kill as the dossier reads it, attributed to its subject. */
export function dossierRaiderIoFirstKill(
  kill: StoredCharacterRaiderIoFirstKill,
  character: CharacterKey
): DossierRaiderIoFirstKill {
  return {
    character,
    raidSlug: kill.raidSlug,
    bossSlug: kill.bossSlug,
    killedAt: kill.killedAt,
    guild: dossierGuild(kill.guild),
    historicWorldRank: kill.historicWorldRank,
    encounter:
      kill.loggedEncounterId === null ||
      PERMANENTLY_UNREAD.has(kill.encounterLimitationCode ?? "")
        ? { state: "none" }
        : kill.encounterState === "read" && kill.encounter
          ? { state: "read", encounter: dossierEncounter(kill.encounter) }
          : { state: "not_read" }
  };
}
