import {
  formatCharacterDisplayName,
  type CharacterGuild,
  type CharacterKey
} from "@slashwho/domain";

/** Renders a realm slug as the name Blizzard displays, e.g. `tarren-mill`. */
export function formatRealmName(realm: string): string {
  return realm
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]!.toLocaleUpperCase("en-US") + part.slice(1))
    .join(" ");
}

/**
 * The browser-tab title for a dossier. The realm is always the character's own:
 * a guild can sit on a different realm, and naming that one would misidentify
 * the character the dossier is about.
 */
export function dossierTitle(
  key: CharacterKey,
  guild: CharacterGuild | null | undefined
): string {
  const name = formatCharacterDisplayName(key.name);
  const realm = formatRealmName(key.realm);
  return guild ? `${name} <${guild.name}> @ ${realm}` : `${name} @ ${realm}`;
}
