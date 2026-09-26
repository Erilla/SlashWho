import { parseRaiderIoCharacterUrl, type CharacterKey } from "@slashwho/domain";

import { raiderIoCharacterUrl } from "./dossier-path";

/**
 * The character a `[region]/[realm]/[name]` route names, and whether the route
 * spelled it canonically. Pure, so a page can use it without pulling in the
 * server's HTTP helpers and their logger. Throws `invalid_character_url` for a
 * route that names no character.
 */
export function parseCharacterRoute(params: {
  region: string;
  realm: string;
  name: string;
}): { key: CharacterKey; canonical: boolean } {
  let decoded: { region: string; realm: string; name: string };
  try {
    decoded = {
      region: decodeURIComponent(params.region),
      realm: decodeURIComponent(params.realm),
      name: decodeURIComponent(params.name)
    };
  } catch {
    throw new Error("invalid_character_url");
  }
  const key = parseRaiderIoCharacterUrl(raiderIoCharacterUrl(decoded));
  return {
    key,
    canonical:
      decoded.region === key.region &&
      decoded.realm === key.realm &&
      decoded.name === key.name
  };
}
