import type { Endpoint, Provider } from "./recorded-payloads.mts";

/**
 * Live reads of the recorded endpoints, shared by the recorder
 * (`record-provider-payloads.mts`) and the drift check (`provider-drift.mts`).
 * Both are out-of-band: neither runs in the pull-request gate.
 *
 * A target names a real character, so nothing here writes, prints or throws
 * one. Every error message is a fixed code.
 */

const raiderIoBaseUrl = "https://raider.io";
const userAgent = "SlashWho (+https://github.com/Erilla/SlashWho)";

export type Target = Readonly<{
  endpoint: Endpoint;
  label: string;
  target: string;
}>;
export type Fetched = Readonly<{ status: number; body: unknown }>;
export type FetchTarget = (target: Target) => Promise<Fetched>;

export const endpointsByProvider: Readonly<
  Record<Provider, readonly string[]>
> = {
  raiderio: ["character", "view-characters"],
  blizzard: [
    "character-profile",
    "guild-roster",
    "character-achievements",
    "playable-class-index"
  ]
};

/** A target that cannot be parsed. Its message never quotes the target. */
export class TargetError extends Error {}

export function parseTarget(provider: Provider, value: string): Target {
  const match = /^([a-z-]+):([a-z0-9-]+)=(.+)$/.exec(value);
  if (!match)
    throw new TargetError("target must be <endpoint>:<label>=<target>");
  const [, endpoint, label, target] = match;
  if (!endpointsByProvider[provider].includes(endpoint!))
    throw new TargetError(`unknown ${provider} endpoint`);
  // Checked here rather than at fetch time, so a malformed target is a usage
  // error before any request, not a failed request.
  if (endpoint === "view-characters") {
    if (target!.startsWith("owner-of:"))
      characterTarget(target!.slice("owner-of:".length));
  } else if (endpoint !== "playable-class-index") {
    characterTarget(target!);
  }
  return {
    endpoint: `${provider}.${endpoint}` as Endpoint,
    label: label!,
    target: target!
  };
}

function characterTarget(value: string): {
  region: string;
  realm: string;
  name: string;
} {
  const [region, realm, name, ...rest] = value.split("/");
  if (!region || !realm || !name || rest.length > 0)
    throw new TargetError("a character target is <region>/<realm>/<name>");
  return {
    region: region.toLocaleLowerCase("en-US"),
    realm: realm.toLocaleLowerCase("en-US"),
    name: name.toLocaleLowerCase("en-US")
  };
}

async function fetchJson(url: URL, init: RequestInit): Promise<Fetched> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000)
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body is read as null; its text is never kept.
  }
  return { status: response.status, body };
}

export function raiderIo(): FetchTarget {
  const headers = { Accept: "application/json", "user-agent": userAgent };
  const raiderIoCharacter = (target: string) => {
    const { region, realm, name } = characterTarget(target);
    const path = ["api", "characters", region, realm, name]
      .map(encodeURIComponent)
      .join("/");
    return fetchJson(new URL(`/${path}`, raiderIoBaseUrl), { headers });
  };
  return async ({ endpoint, target }) => {
    if (endpoint === "raiderio.character") return raiderIoCharacter(target);
    // `owner-of:<character>` reads the owner from that character's profile, so
    // the owner's name is never typed on a command line or seen by anyone.
    let owner = target;
    if (target.startsWith("owner-of:")) {
      const character = await raiderIoCharacter(
        target.slice("owner-of:".length)
      );
      const name = (
        character.body as { characterDetails?: { user?: { name?: unknown } } }
      )?.characterDetails?.user?.name;
      if (character.status !== 200 || typeof name !== "string")
        throw new Error("raiderio_character_has_no_public_owner");
      owner = name;
    }
    const url = new URL("/api/user/view-characters", raiderIoBaseUrl);
    url.searchParams.set("name", owner);
    return fetchJson(url, { headers });
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith("replace-with"))
    throw new Error(`${name.toLowerCase()}_required`);
  return value;
}

function blizzardSlug(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/g, "-");
}

export function blizzard(): FetchTarget {
  const clientId = requiredEnvironment("BLIZZARD_CLIENT_ID");
  const clientSecret = requiredEnvironment("BLIZZARD_CLIENT_SECRET");
  let token: Promise<string> | undefined;

  const accessToken = () =>
    (token ??= (async () => {
      const { status, body } = await fetchJson(
        new URL("https://oauth.battle.net/token"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
          },
          body: "grant_type=client_credentials"
        }
      );
      const value = (body as { access_token?: unknown } | null)?.access_token;
      if (status !== 200 || typeof value !== "string")
        throw new Error("blizzard_token_unavailable");
      return value;
    })());

  const get = async (region: string, path: string, namespace: string) => {
    const url = new URL(path, `https://${region}.api.blizzard.com`);
    url.searchParams.set("namespace", `${namespace}-${region}`);
    url.searchParams.set("locale", "en_GB");
    return fetchJson(url, {
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        Accept: "application/json"
      }
    });
  };
  const profilePath = (realm: string, name: string) =>
    `/profile/wow/character/${encodeURIComponent(realm)}/${encodeURIComponent(name)}`;

  return async ({ endpoint, target }) => {
    if (endpoint === "blizzard.playable-class-index")
      return get(
        target.toLocaleLowerCase("en-US"),
        "/data/wow/playable-class/index",
        "static"
      );

    const { region, realm, name } = characterTarget(target);
    if (endpoint === "blizzard.character-profile")
      return get(region, profilePath(realm, name), "profile");
    if (endpoint === "blizzard.character-achievements")
      return get(region, `${profilePath(realm, name)}/achievements`, "profile");

    // A roster is addressed through a member: the recorder reads the member's
    // profile for the guild, so the guild's name is never typed or kept.
    const profile = await get(region, profilePath(realm, name), "profile");
    const guild = (
      profile.body as {
        guild?: { name?: unknown; realm?: { slug?: unknown } };
      } | null
    )?.guild;
    if (
      profile.status !== 200 ||
      typeof guild?.name !== "string" ||
      typeof guild.realm?.slug !== "string"
    )
      throw new Error("blizzard_roster_member_has_no_guild");
    return get(
      region,
      `/data/wow/guild/${encodeURIComponent(blizzardSlug(guild.realm.slug))}/${encodeURIComponent(blizzardSlug(guild.name))}/roster`,
      "profile"
    );
  };
}
