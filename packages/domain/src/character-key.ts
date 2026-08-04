export const supportedRegions = ["us", "eu", "kr", "tw"] as const;

export type Region = (typeof supportedRegions)[number];

export type CharacterKey = Readonly<{
  region: Region;
  realm: string;
  name: string;
}>;

export function parseRaiderIoCharacterUrl(input: string): CharacterKey {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("invalid_character_url");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "raider.io" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid_character_url");
  }

  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new Error("invalid_character_url");
  }

  if (parts.length !== 4 || parts[0].toLowerCase() !== "characters") {
    throw new Error("invalid_character_url");
  }

  const [region, realm, name] = parts
    .slice(1)
    .map((part) => part.toLocaleLowerCase("en-US"));

  if (
    !supportedRegions.includes(region as Region) ||
    !/^[a-z0-9-]+$/.test(realm) ||
    !/^[\p{L}\p{M}'-]+$/u.test(name)
  ) {
    throw new Error("invalid_character_url");
  }

  return { region: region as Region, realm, name };
}

export function toCharacterPath(key: CharacterKey): string {
  return `/characters/${key.region}/${key.realm}/${key.name}`;
}

export function toRaiderIoUrl(key: CharacterKey): string {
  return `https://raider.io${toCharacterPath(key)}`;
}
