import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  leakedIdentities,
  PlaceholderBook,
  recordPayload,
  RecordingRefused,
  verifyRecording,
  type Endpoint,
  type Provider,
  type Recording
} from "./recorded-payloads.mts";

/**
 * Records live Blizzard or Raider.IO responses as redacted fixtures under
 * `tests/fixtures/recorded/`. An out-of-band step run by a maintainer, never by
 * the pull-request gate; see `tests/fixtures/recorded/README.md`.
 *
 *   corepack pnpm exec tsx --env-file-if-exists=.env scripts/record-provider-payloads.mts raiderio character:no-guild=eu/silvermoon/name
 *   corepack pnpm exec tsx --env-file-if-exists=.env scripts/record-provider-payloads.mts blizzard guild-roster:root-guild=eu/argent-dawn/name
 *
 * Each target is `<endpoint>:<label>=<target>`. The label names the output
 * file, so it must describe the scenario, never the character. Targets are
 * read from the command line only and are never written or printed: output is
 * the file name and the status. Every recording is projected through the
 * allow-list, checked for any real identity it replaced, and verified before
 * anything is written; one failure writes nothing.
 */

const raiderIoBaseUrl = "https://raider.io";
const userAgent = "SlashWho (+https://github.com/Erilla/SlashWho)";
const outputRoot = resolve(import.meta.dirname, "../tests/fixtures/recorded");

type Target = Readonly<{ endpoint: Endpoint; label: string; target: string }>;
type Fetched = Readonly<{ status: number; body: unknown }>;

const endpointsByProvider: Readonly<Record<Provider, readonly string[]>> = {
  raiderio: ["character", "view-characters"],
  blizzard: [
    "character-profile",
    "guild-roster",
    "character-achievements",
    "playable-class-index"
  ]
};

function usage(message: string): never {
  process.stderr.write(
    `${message}\nusage: record-provider-payloads.mts <raiderio|blizzard> <endpoint>:<label>=<target>... [--show-unrecognised]\n`
  );
  process.exit(2);
}

function parseTarget(provider: Provider, value: string): Target {
  const match = /^([a-z-]+):([a-z0-9-]+)=(.+)$/.exec(value);
  if (!match) usage("target must be <endpoint>:<label>=<target>");
  const [, endpoint, label, target] = match;
  if (!endpointsByProvider[provider].includes(endpoint!))
    usage(`unknown ${provider} endpoint`);
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
    usage("a character target is <region>/<realm>/<name>");
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
    // A non-JSON body is recorded as null; its text is never kept.
  }
  return { status: response.status, body };
}

function raiderIo(): (target: Target) => Promise<Fetched> {
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

function blizzard(): (target: Target) => Promise<Fetched> {
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

function outputPath(recording: Recording, label: string): string {
  const [provider, endpoint] = recording.endpoint.split(".");
  return resolve(outputRoot, provider!, `${endpoint}-${label}.json`);
}

async function main() {
  const args = process.argv.slice(2);
  const showUnrecognised = args.includes("--show-unrecognised");
  const [provider, ...rawTargets] = args.filter(
    (arg) => arg !== "--show-unrecognised"
  );
  if (provider !== "raiderio" && provider !== "blizzard")
    usage("provider must be raiderio or blizzard");
  if (rawTargets.length === 0) usage("at least one target is required");
  const targets = rawTargets.map((value) => parseTarget(provider, value));

  const fetchTarget = provider === "raiderio" ? raiderIo() : blizzard();
  const book = new PlaceholderBook();
  const recordedOn = new Date().toISOString().slice(0, 10);
  const pending: { path: string; serialised: string }[] = [];

  for (const target of targets) {
    const { status, body } = await fetchTarget(target);
    let recording: Recording;
    try {
      recording = recordPayload(body, {
        endpoint: target.endpoint,
        status,
        recordedOn,
        book
      });
    } catch (error) {
      if (!(error instanceof RecordingRefused)) throw error;
      // The value is shown only when asked for, and only on this terminal: it
      // is the upstream text the allow-list has not yet reviewed.
      const shown =
        showUnrecognised && error.value !== undefined
          ? ` (value: ${JSON.stringify(error.value)})`
          : "";
      // Reported and exited rather than rethrown: an uncaught error would
      // print the refusal's properties, including the unreviewed value.
      process.stderr.write(
        `${target.endpoint}:${target.label} status ${String(status)}: ${error.message}${shown}
`
      );
      process.exit(1);
    }
    const violations = verifyRecording(recording);
    if (violations.length > 0)
      throw new Error(
        `${target.endpoint}:${target.label} failed verification: ${violations.map((v) => `${v.path} ${v.problem}`).join("; ")}`
      );
    pending.push({
      path: outputPath(recording, target.label),
      serialised: `${JSON.stringify(recording, null, 2)}\n`
    });
    process.stdout.write(
      `recorded ${target.endpoint}:${target.label} (status ${String(status)})\n`
    );
  }

  // Checked only once every target is recorded: a name replaced in a later
  // file must not survive in an earlier one.
  for (const { path, serialised } of pending) {
    if (leakedIdentities(serialised, book).length > 0)
      throw new Error(`refusing to write ${path}: a real identity survived`);
  }
  for (const { path, serialised } of pending) {
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, serialised, "utf8");
    process.stdout.write(`wrote ${path}\n`);
  }
}

await main();
