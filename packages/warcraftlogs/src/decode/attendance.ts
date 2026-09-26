import {
  nonEmptyString,
  record,
  validTimestampMilliseconds
} from "./primitives";

export type GuildAttendanceReport = Readonly<{
  code: string;
  /** When the report started, or null when attendance does not say. */
  startTime: number | null;
  /**
   * Whether attendance lists the character. Null means "unknown", never
   * "absent": only a complete, readable list may rule a report out.
   */
  listsCharacter: boolean | null;
}>;

export function guildAttendancePage(
  value: unknown,
  characterName: string
): Readonly<{
  reports: readonly GuildAttendanceReport[];
  hasMorePages: boolean;
}> | null {
  const guild = record(record(record(value)?.data)?.guildData)?.guild;
  const attendance = record(record(guild)?.attendance);
  const data = attendance?.data;
  const hasMorePages = attendance?.has_more_pages;
  if (!Array.isArray(data) || typeof hasMorePages !== "boolean") return null;
  const reports: GuildAttendanceReport[] = [];
  for (const value of data) {
    const entry = record(value);
    const code = nonEmptyString(entry?.code);
    if (!code) return null;
    reports.push({
      code,
      startTime: validTimestampMilliseconds(entry?.startTime),
      listsCharacter: attendanceListsCharacter(entry?.players, characterName)
    });
  }
  return { reports, hasMorePages };
}

/**
 * Whether an attendance response is Warcraft Logs saying it has no such guild,
 * as opposed to a page it could not read.
 */
export function guildIsAbsent(value: unknown): boolean {
  const guildData = record(record(record(value)?.data)?.guildData);
  return guildData !== null && guildData.guild === null;
}

function attendanceListsCharacter(
  players: unknown,
  characterName: string
): boolean | null {
  if (!Array.isArray(players) || players.length === 0) return null;
  const wanted = characterName.normalize("NFC");
  let unreadable = false;
  for (const player of players) {
    const name = nonEmptyString(record(player)?.name);
    if (!name) {
      unreadable = true;
      continue;
    }
    const listed = name.normalize("NFC").toLocaleLowerCase("en-US");
    // A player from another realm may be written with a realm suffix. The
    // hydrated report decides the realm; this may only say "not this name".
    if (listed === wanted || listed.split("-")[0] === wanted) return true;
  }
  return unreadable ? null : false;
}
