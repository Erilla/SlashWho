export const supportedRegions = ["us", "eu", "kr", "tw"] as const;

export type Region = (typeof supportedRegions)[number];

export type CharacterKey = Readonly<{
  region: Region;
  realm: string;
  name: string;
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
  const [region, realm, name] = parts
    .slice(1)
    .map((part) => part.toLocaleLowerCase("en-US"));
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

export function toCharacterPath(key: CharacterKey): string {
  return `/characters/${key.region}/${key.realm}/${key.name}`;
}

export function toRaiderIoUrl(key: CharacterKey): string {
  return `https://raider.io${toCharacterPath(key)}`;
}
