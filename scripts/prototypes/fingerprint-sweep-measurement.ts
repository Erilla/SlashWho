/**
 * PROTOTYPE — measures the live guild-roster fingerprint path for Ictinus.
 * It never writes to the database or disk and discards every upstream body and
 * fingerprint after use. Its sole output is a redacted aggregate JSON report.
 */

type CharacterKey = Readonly<{
  region: "eu";
  realm: string;
  name: string;
}>;
type Fingerprint = ReadonlyMap<number, number>;
type Match = Readonly<{
  common: number;
  identical: number;
  percent: number;
  isMatch: boolean;
}>;
type Guild = Readonly<{ realm: string; name: string; depth: number }>;
type FailureKind =
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "other_http"
  | "transport"
  | "schema";
type Distribution = Readonly<{
  count: number;
  min: number | null;
  median: number | null;
  max: number | null;
}>;
type KnownComparison = Readonly<{
  encountered: boolean;
  common: number | null;
  identical: number | null;
  percent: number | null;
  isMatch: boolean | null;
}>;
type MeasurementSummary = Readonly<{
  root: CharacterKey;
  requestCap: number;
  capReached: boolean;
  guildsVisited: number;
  candidatesConsidered: number;
  achievementRequests: number;
  wallTimeMs: number;
  payloadBytes: {
    contentLength: Distribution;
    receivedBody: Distribution;
  };
  scores: Distribution;
  knownCharacters: Record<string, KnownComparison>;
  matchedCharacters: number;
  failures: Record<FailureKind, number>;
}>;

class ResponseSchemaError extends Error {}

const root: CharacterKey = {
  region: "eu",
  realm: "argent-dawn",
  name: "ictinus"
};
const knownCharacterNames = [
  "ictinus",
  "driptinus",
  "boptinus",
  "cryptinus",
  "mistakinus"
] as const;
const knownCharacters = new Set<string>(knownCharacterNames);
const requestCap = 3_000;
const minCommonAchievements = 200;
const matchPercentThreshold = 20;

function requiredEnvironment(
  name: "BLIZZARD_CLIENT_ID" | "BLIZZARD_CLIENT_SECRET"
): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLowerCase()}_required`);
  return value;
}

function compareFingerprints(left: Fingerprint, right: Fingerprint): Match {
  let common = 0;
  let identical = 0;
  for (const [id, timestamp] of left) {
    const otherTimestamp = right.get(id);
    if (otherTimestamp === undefined) continue;
    common += 1;
    if (otherTimestamp === timestamp) identical += 1;
  }
  const percent = common === 0 ? 0 : (identical / common) * 100;
  return {
    common,
    identical,
    percent,
    isMatch: common >= minCommonAchievements && percent >= matchPercentThreshold
  };
}

function normalizedKey(value: Pick<CharacterKey, "realm" | "name">): string {
  return `${value.realm.toLocaleLowerCase("en-US")}/${value.name.toLocaleLowerCase("en-US")}`;
}

function normalizedGuildKey(value: Pick<Guild, "realm" | "name">): string {
  return `${value.realm.toLocaleLowerCase("en-US")}/${value.name.toLocaleLowerCase("en-US")}`;
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return { count: 0, min: null, median: null, max: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return {
    count: sorted.length,
    min: sorted[0],
    median,
    max: sorted.at(-1) ?? null
  };
}

function emptyFailures(): Record<FailureKind, number> {
  return {
    not_found: 0,
    rate_limited: 0,
    server_error: 0,
    other_http: 0,
    transport: 0,
    schema: 0
  };
}

function emptyKnownComparisons(): Record<string, KnownComparison> {
  return Object.fromEntries(
    knownCharacterNames.map((name) => [
      name,
      {
        encountered: name === root.name,
        common: null,
        identical: null,
        percent: null,
        isMatch: null
      }
    ])
  );
}

function failureKind(status: number): FailureKind {
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "other_http";
}

async function getAccessToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  const response = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
    },
    body: "grant_type=client_credentials"
  });
  if (!response.ok) throw new Error(`oauth_http_${response.status}`);
  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { access_token?: unknown }).access_token !== "string"
  ) {
    throw new Error("oauth_schema");
  }
  return (payload as { access_token: string }).access_token;
}

async function measuredJson(
  url: URL,
  token: string
): Promise<{
  status: number;
  elapsedMs: number;
  contentLength: number | null;
  receivedBytes: number;
  body: unknown;
}> {
  const startedAt = performance.now();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  const elapsedMs = performance.now() - startedAt;
  const contentLengthHeader = response.headers.get("Content-Length");
  const contentLength =
    contentLengthHeader && /^\d+$/.test(contentLengthHeader)
      ? Number(contentLengthHeader)
      : null;
  const bytes = await response.arrayBuffer();
  let body: unknown = null;
  if (bytes.byteLength > 0) {
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ResponseSchemaError("invalid_json_response");
    }
  }
  return {
    status: response.status,
    elapsedMs,
    contentLength,
    receivedBytes: bytes.byteLength,
    body
  };
}

function profileUrl(character: CharacterKey): URL {
  return new URL(
    `https://eu.api.blizzard.com/profile/wow/character/${encodeURIComponent(character.realm)}/${encodeURIComponent(character.name)}?namespace=profile-eu&locale=en_GB`
  );
}

function achievementsUrl(character: CharacterKey): URL {
  return new URL(
    `https://eu.api.blizzard.com/profile/wow/character/${encodeURIComponent(character.realm)}/${encodeURIComponent(character.name)}/achievements?namespace=profile-eu&locale=en_GB`
  );
}

function rosterUrl(guild: Guild): URL {
  return new URL(
    `https://eu.api.blizzard.com/data/wow/guild/${encodeURIComponent(guild.realm)}/${encodeURIComponent(guild.name)}/roster?namespace=profile-eu&locale=en_GB`
  );
}

function guildFromProfile(value: unknown, depth: number): Guild | null {
  if (!value || typeof value !== "object") return null;
  const guild = (value as { guild?: unknown }).guild;
  if (!guild || typeof guild !== "object") return null;
  const name = (guild as { name?: unknown }).name;
  const realm = (guild as { realm?: { slug?: unknown } }).realm?.slug;
  return typeof name === "string" && typeof realm === "string"
    ? { name, realm, depth }
    : null;
}

function rosterMembers(value: unknown): CharacterKey[] | null {
  if (!value || typeof value !== "object") return null;
  const members = (value as { members?: unknown }).members;
  if (!Array.isArray(members)) return null;
  const characters: CharacterKey[] = [];
  for (const member of members) {
    const character =
      member && typeof member === "object"
        ? (member as { character?: unknown }).character
        : null;
    if (!character || typeof character !== "object") continue;
    const name = (character as { name?: unknown }).name;
    const realm = (character as { realm?: { slug?: unknown } }).realm?.slug;
    if (typeof name === "string" && typeof realm === "string") {
      characters.push({
        region: "eu",
        realm,
        name: name.toLocaleLowerCase("en-US")
      });
    }
  }
  return characters;
}

function fingerprintFromAchievements(value: unknown): Fingerprint | null {
  if (!value || typeof value !== "object") return null;
  const achievements = (value as { achievements?: unknown }).achievements;
  if (!Array.isArray(achievements)) return null;
  const entries = new Map<number, number>();
  for (const achievement of achievements) {
    if (!achievement || typeof achievement !== "object") continue;
    const id = (achievement as { id?: unknown }).id;
    const timestamp = (achievement as { completed_timestamp?: unknown })
      .completed_timestamp;
    if (typeof id === "number" && typeof timestamp === "number") {
      entries.set(id, timestamp);
    }
  }
  return entries;
}

async function main(): Promise<MeasurementSummary> {
  const startedAt = performance.now();
  const failures = emptyFailures();
  const contentLengths: number[] = [];
  const receivedBytes: number[] = [];
  const scores: number[] = [];
  const knownComparisons = emptyKnownComparisons();
  const clientId = requiredEnvironment("BLIZZARD_CLIENT_ID");
  const clientSecret = requiredEnvironment("BLIZZARD_CLIENT_SECRET");
  let capReached = false;
  let guildsVisited = 0;
  let candidatesConsidered = 0;
  let achievementRequests = 0;
  let matchedCharacters = 0;

  const summary = (): MeasurementSummary => ({
    root,
    requestCap,
    capReached,
    guildsVisited,
    candidatesConsidered,
    achievementRequests,
    wallTimeMs: Math.round(performance.now() - startedAt),
    payloadBytes: {
      contentLength: distribution(contentLengths),
      receivedBody: distribution(receivedBytes)
    },
    scores: distribution(scores),
    knownCharacters: knownComparisons,
    matchedCharacters,
    failures
  });

  let token: string;
  try {
    token = await getAccessToken(clientId, clientSecret);
  } catch {
    failures.transport += 1;
    return summary();
  }

  async function fetchProfile(character: CharacterKey): Promise<Guild | null> {
    try {
      const response = await measuredJson(profileUrl(character), token);
      if (!response.status.toString().startsWith("2")) {
        failures[failureKind(response.status)] += 1;
        return null;
      }
      const guild = guildFromProfile(response.body, 0);
      if (!guild) failures.schema += 1;
      return guild;
    } catch (error) {
      failures[error instanceof ResponseSchemaError ? "schema" : "transport"] +=
        1;
      return null;
    }
  }

  async function fetchRoster(guild: Guild): Promise<CharacterKey[] | null> {
    try {
      const response = await measuredJson(rosterUrl(guild), token);
      if (!response.status.toString().startsWith("2")) {
        failures[failureKind(response.status)] += 1;
        return null;
      }
      const members = rosterMembers(response.body);
      if (!members) failures.schema += 1;
      return members;
    } catch (error) {
      failures[error instanceof ResponseSchemaError ? "schema" : "transport"] +=
        1;
      return null;
    }
  }

  async function fetchFingerprint(
    character: CharacterKey
  ): Promise<Fingerprint | null> {
    achievementRequests += 1;
    try {
      const response = await measuredJson(achievementsUrl(character), token);
      if (response.contentLength !== null) {
        contentLengths.push(response.contentLength);
      }
      receivedBytes.push(response.receivedBytes);
      if (!response.status.toString().startsWith("2")) {
        failures[failureKind(response.status)] += 1;
        return null;
      }
      const fingerprint = fingerprintFromAchievements(response.body);
      if (!fingerprint) failures.schema += 1;
      return fingerprint;
    } catch (error) {
      failures[error instanceof ResponseSchemaError ? "schema" : "transport"] +=
        1;
      return null;
    }
  }

  const rootFingerprint = await fetchFingerprint(root);
  const rootGuild = await fetchProfile(root);
  if (!rootFingerprint || !rootGuild) return summary();

  const guildQueue: Guild[] = [rootGuild];
  const visitedGuilds = new Set<string>();
  const seenCharacters = new Set<string>([normalizedKey(root)]);

  while (guildQueue.length > 0 && !capReached) {
    const guild = guildQueue.shift();
    if (!guild) break;
    const guildKey = normalizedGuildKey(guild);
    if (visitedGuilds.has(guildKey)) continue;
    visitedGuilds.add(guildKey);
    guildsVisited += 1;

    const members = await fetchRoster(guild);
    if (!members) continue;
    for (const candidate of members) {
      if (achievementRequests >= requestCap) {
        capReached = true;
        break;
      }
      const characterKey = normalizedKey(candidate);
      if (seenCharacters.has(characterKey)) continue;
      seenCharacters.add(characterKey);
      candidatesConsidered += 1;

      const fingerprint = await fetchFingerprint(candidate);
      if (!fingerprint) continue;
      const match = compareFingerprints(rootFingerprint, fingerprint);
      scores.push(match.percent);

      const knownName = candidate.name.toLocaleLowerCase("en-US");
      if (knownCharacters.has(knownName)) {
        knownComparisons[knownName] = {
          encountered: true,
          common: match.common,
          identical: match.identical,
          percent: match.percent,
          isMatch: match.isMatch
        };
      }

      if (!match.isMatch) continue;
      matchedCharacters += 1;
      const nextGuild = await fetchProfile(candidate);
      if (nextGuild) {
        guildQueue.push({ ...nextGuild, depth: guild.depth + 1 });
      }
    }
  }

  return summary();
}

void main()
  .then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  })
  .catch(() => {
    process.stdout.write(
      `${JSON.stringify({
        root,
        requestCap,
        failures: { transport: 1 },
        message: "prototype_failed_without_response_output"
      })}\n`
    );
    process.exitCode = 1;
  });
