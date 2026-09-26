export const supportedRegions = ["us", "eu", "kr", "tw"] as const;

export type Region = (typeof supportedRegions)[number];

export type CharacterKey = Readonly<{
  region: Region;
  realm: string;
  name: string;
}>;

/**
 * A guild as named by an upstream character payload. It carries its own realm
 * and region because a character's guild need not sit on the character's realm.
 */
export type CharacterGuild = Readonly<{
  name: string;
  region: Region;
  realm: string;
}>;

function invalidCharacterUrl(): never {
  throw new Error("invalid_character_url");
}

function parseAbsoluteHttpsUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return invalidCharacterUrl();
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return invalidCharacterUrl();
  }

  return url;
}

function parseCharacterPath(url: URL, expectedPrefix: string): CharacterKey {
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return invalidCharacterUrl();
  }
  if (parts.length !== 4 || parts[0].toLowerCase() !== expectedPrefix) {
    return invalidCharacterUrl();
  }
  const [region, accentedRealm, name] = parts
    .slice(1)
    .map((part) => part.toLocaleLowerCase("en-US"));
  // Raider.IO slugs keep a realm's accents ("aggra-português"); Blizzard's,
  // which every lookup uses, drop them ("aggra-portugues").
  const realm = accentedRealm.normalize("NFD").replace(/\p{M}/gu, "");
  if (
    !supportedRegions.includes(region as Region) ||
    !/^[a-z0-9-]+$/.test(realm) ||
    !/^[\p{L}\p{M}'-]+$/u.test(name)
  ) {
    return invalidCharacterUrl();
  }
  return { region: region as Region, realm, name };
}

export function parseRaiderIoCharacterUrl(input: string): CharacterKey {
  const url = parseAbsoluteHttpsUrl(input);
  if (url.hostname !== "raider.io") return invalidCharacterUrl();
  return parseCharacterPath(url, "characters");
}

function parseWarcraftLogsCharacterUrl(url: URL): CharacterKey {
  return parseCharacterPath(url, "character");
}

export function parseApplicantCharacterUrl(input: string): CharacterKey {
  const url = parseAbsoluteHttpsUrl(input);
  if (url.hostname === "raider.io") return parseRaiderIoCharacterUrl(input);
  if (url.hostname === "www.warcraftlogs.com")
    return parseWarcraftLogsCharacterUrl(url);
  return invalidCharacterUrl();
}

/**
 * Reads the stable character ID from a Warcraft Logs `/character/id/<n>` URL,
 * or `undefined` for anything else. The ID names a character across renames
 * and realm transfers, but carries no name, realm or region: those have to be
 * resolved through Warcraft Logs before the character can be looked up
 * anywhere else, so it is deliberately not an applicant character URL.
 */
export function parseWarcraftLogsCharacterIdUrl(
  input: string
): number | undefined {
  let url: URL;
  try {
    url = parseAbsoluteHttpsUrl(input);
  } catch {
    return undefined;
  }
  if (url.hostname !== "www.warcraftlogs.com") return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    parts.length !== 3 ||
    parts[0].toLowerCase() !== "character" ||
    parts[1].toLowerCase() !== "id" ||
    !/^[1-9][0-9]*$/.test(parts[2])
  ) {
    return undefined;
  }
  const id = Number(parts[2]);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function toCharacterPath(key: CharacterKey): string {
  return `/characters/${key.region}/${key.realm}/${key.name}`;
}

export function toRaiderIoUrl(key: CharacterKey): string {
  return `https://raider.io${toCharacterPath(key)}`;
}
