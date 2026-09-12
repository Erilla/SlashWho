type JournalEncounter = Readonly<{
  id: unknown;
  name: unknown;
}>;

type JournalRaid = Readonly<{
  id: unknown;
  name: unknown;
  category: unknown;
  modes: unknown;
  encounters: unknown;
}>;

export type GeneratedJournalRaid = Readonly<{
  journalRaidId: string;
  raidName: string;
  encounters: readonly Readonly<{
    journalBossId: string;
    bossName: string;
    bossOrder: number;
  }>[];
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function normalizeJournalRaid(value: unknown): GeneratedJournalRaid | null {
  const raid = value as JournalRaid;
  const category = record(raid.category);
  if (category?.type !== "RAID" || !Array.isArray(raid.modes)) return null;
  const hasMythicMode = raid.modes.some((value) => {
    const mode = record(value);
    return record(mode?.mode)?.type === "MYTHIC";
  });
  if (!hasMythicMode || !Array.isArray(raid.encounters)) return null;

  const journalRaidId = positiveInteger(raid.id);
  const raidName = nonEmptyString(raid.name);
  if (!journalRaidId || !raidName) return null;

  const encounters = raid.encounters.map((value, index) => {
    const encounter = value as JournalEncounter;
    const journalBossId = positiveInteger(encounter.id);
    const bossName = nonEmptyString(encounter.name);
    return journalBossId && bossName
      ? { journalBossId: String(journalBossId), bossName, bossOrder: index + 1 }
      : null;
  });
  if (encounters.length === 0 || encounters.some((entry) => entry === null)) {
    return null;
  }
  return {
    journalRaidId: String(journalRaidId),
    raidName,
    encounters: encounters as GeneratedJournalRaid["encounters"]
  };
}
