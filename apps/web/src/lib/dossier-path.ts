import type { CharacterKey } from "@slashwho/domain";

/**
 * Anything addressed as region, realm and name: a character key, a guild, or
 * what a visitor typed before it has been validated as either.
 */
type RealmScopedName = Readonly<{
  region: string;
  realm: string;
  name: string;
}>;

/**
 * `region/realm/name`, each segment encoded so a name outside ASCII survives
 * as its canonical key rather than bouncing through a route's redirect.
 */
export function characterPathSegments(key: RealmScopedName): string {
  return `${encodeURIComponent(key.region)}/${encodeURIComponent(key.realm)}/${encodeURIComponent(key.name)}`;
}

/** The dossier page for a character. */
export function dossierPath(key: CharacterKey): string {
  return `/dossiers/${characterPathSegments(key)}`;
}

/** A character's Warcraft Logs profile, which is also a valid research URL. */
export function warcraftLogsCharacterUrl(key: RealmScopedName): string {
  return `https://www.warcraftlogs.com/character/${characterPathSegments(key)}`;
}

/** A character's Raider.IO profile, which is also a valid research URL. */
export function raiderIoCharacterUrl(key: RealmScopedName): string {
  return `https://raider.io/characters/${characterPathSegments(key)}`;
}
