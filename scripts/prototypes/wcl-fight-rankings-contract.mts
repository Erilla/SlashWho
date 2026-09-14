import { pathToFileURL } from "node:url";

export type RankingsProbeOptions = Readonly<{
  reportCode: string;
  fightId: number;
  encounterId: number;
  difficulty: number;
}>;

type SanitizationState = {
  reportCodes: Map<string, string>;
  names: Map<string, string>;
  realms: Map<string, string>;
  regions: Map<string, string>;
  serverIds: Map<number, number>;
  actorIds: Map<number, number>;
  characterIds: Map<number, number>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedKey(value: string): string {
  return value.replaceAll(/[^a-z0-9]/gi, "").toLocaleLowerCase("en-US");
}

function reportCodeKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized === "code" || normalized === "reportcode";
}

function nameKey(key: string): boolean {
  return normalizedKey(key).includes("name");
}

function realmKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized.includes("realm") || normalized.includes("server");
}

function regionKey(key: string): boolean {
  return normalizedKey(key).includes("region");
}

function replacement<T>(map: Map<T, string>, value: T, label: string): void {
  if (!map.has(value)) map.set(value, `fixture-${label}-${map.size + 1}`);
}

function collectSensitiveValues(
  value: unknown,
  state: SanitizationState
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectSensitiveValues(entry, state);
    return;
  }
  const entry = record(value);
  if (!entry) return;

  if (rankedCharacterRecord(entry) && typeof entry.id === "number") {
    if (!state.characterIds.has(entry.id)) {
      state.characterIds.set(entry.id, 2000 + state.characterIds.size + 1);
    }
  }
  const server = record(entry.server);
  if (typeof server?.id === "number" && !state.serverIds.has(server.id)) {
    state.serverIds.set(server.id, 3000 + state.serverIds.size + 1);
  }

  for (const [key, child] of Object.entries(entry)) {
    if (typeof child === "string") {
      if (reportCodeKey(key)) replacement(state.reportCodes, child, "report");
      if (nameKey(key)) replacement(state.names, child, "name");
      if (realmKey(key)) replacement(state.realms, child, "realm");
      if (regionKey(key)) replacement(state.regions, child, "region");
    }
    collectSensitiveValues(child, state);
  }

  const actors = entry.actors;
  if (!Array.isArray(actors)) return;
  for (const actorValue of actors) {
    const actor = record(actorValue);
    if (typeof actor?.id !== "number") continue;
    if (!state.actorIds.has(actor.id)) {
      state.actorIds.set(actor.id, 1000 + state.actorIds.size + 1);
    }
    if (
      typeof actor.gameID === "number" &&
      !state.characterIds.has(actor.gameID)
    ) {
      state.characterIds.set(actor.gameID, 2000 + state.characterIds.size + 1);
    }
  }
}

function redactString(value: string, state: SanitizationState): string {
  let redacted = value;
  for (const [raw, fixture] of state.reportCodes) {
    redacted = redacted.replaceAll(raw, fixture);
  }
  for (const [raw, fixture] of state.names) {
    redacted = redacted.replaceAll(raw, fixture);
  }
  for (const [raw, fixture] of state.realms) {
    redacted = redacted.replaceAll(raw, fixture);
  }
  for (const [raw, fixture] of state.regions) {
    redacted = redacted.replaceAll(raw, fixture);
  }
  return redacted;
}

function rankedCharacterRecord(value: Record<string, unknown>): boolean {
  return (
    typeof value.name === "string" &&
    record(value.server) !== null &&
    typeof value.class === "string" &&
    typeof value.spec === "string"
  );
}

function masterActorRecord(value: Record<string, unknown>): boolean {
  return typeof value.type === "string" && typeof value.id === "number";
}

function serverRecord(value: Record<string, unknown>): boolean {
  return typeof value.name === "string" && "region" in value;
}

function sanitizeNumber(
  value: number,
  owner: Record<string, unknown> | undefined,
  key: string | undefined,
  state: SanitizationState
): number {
  const normalized = key && normalizedKey(key);
  if (normalized === "gameid") return state.characterIds.get(value) ?? value;
  if (normalized === "actorid") {
    return state.actorIds.get(value) ?? state.characterIds.get(value) ?? value;
  }
  if (normalized === "id" && owner && masterActorRecord(owner)) {
    return state.actorIds.get(value) ?? value;
  }
  if (normalized === "id" && owner && rankedCharacterRecord(owner)) {
    return state.characterIds.get(value) ?? value;
  }
  if (normalized === "id" && owner && serverRecord(owner)) {
    return state.serverIds.get(value) ?? value;
  }
  return value;
}

function sanitizeValue(
  value: unknown,
  state: SanitizationState,
  owner?: Record<string, unknown>,
  key?: string
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, state, owner, key));
  }
  const entry = record(value);
  if (!entry) {
    if (typeof value === "number")
      return sanitizeNumber(value, owner, key, state);
    return typeof value === "string" ? redactString(value, state) : value;
  }

  return Object.fromEntries(
    Object.entries(entry).map(([childKey, child]) => {
      return [childKey, sanitizeValue(child, state, entry, childKey)];
    })
  );
}

export function sanitizeRankingsFixture(value: unknown): unknown {
  const state: SanitizationState = {
    reportCodes: new Map(),
    names: new Map(),
    realms: new Map(),
    regions: new Map(),
    serverIds: new Map(),
    actorIds: new Map(),
    characterIds: new Map()
  };
  collectSensitiveValues(value, state);
  return sanitizeValue(value, state);
}

function positiveInteger(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    throw new Error("invalid_scope_argument");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid_scope_argument");
  return parsed;
}

export function parseContractProbeOptions(
  argv: readonly string[]
): RankingsProbeOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--report-code",
    "--fight-id",
    "--encounter-id",
    "--difficulty"
  ]);

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !allowed.has(key) || value === undefined || values.has(key)) {
      throw new Error("invalid_scope_argument");
    }
    values.set(key, value);
  }

  const reportCode = values.get("--report-code");
  const fightId = values.get("--fight-id");
  const encounterId = values.get("--encounter-id");
  const difficulty = values.get("--difficulty");
  if (
    reportCode === undefined ||
    fightId === undefined ||
    encounterId === undefined ||
    difficulty === undefined
  ) {
    throw new Error("missing_scope_argument");
  }
  if (!reportCode) throw new Error("invalid_scope_argument");

  return {
    reportCode,
    fightId: positiveInteger(fightId),
    encounterId: positiveInteger(encounterId),
    difficulty: positiveInteger(difficulty)
  };
}

type RankingCharacterIdentity = Readonly<{
  id: number;
  name: string;
  realm: string;
  region: string;
}>;

function normalizedIdentityPart(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function normalizedRealm(value: string): string {
  return value.replaceAll(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase("en-US");
}

function rankingIdentities(
  value: unknown
): readonly RankingCharacterIdentity[] {
  const report = record(record(record(value)?.data)?.reportData)?.report;
  const reportRecord = record(report);
  const metrics = ["damage", "healing", "bossDamage"];
  const identities = new Map<number, RankingCharacterIdentity>();
  for (const metric of metrics) {
    const rows = record(reportRecord?.[metric])?.data;
    if (!Array.isArray(rows)) continue;
    for (const rowValue of rows) {
      const roles = record(rowValue)?.roles;
      if (!roles) continue;
      for (const role of Object.values(roles)) {
        const characters = record(role)?.characters;
        if (!Array.isArray(characters)) continue;
        for (const characterValue of characters) {
          const character = record(characterValue);
          const server = character && record(character.server);
          const id = character?.id;
          const name = character?.name;
          const realm = server?.name;
          const region = server?.region;
          if (
            typeof id !== "number" ||
            !Number.isSafeInteger(id) ||
            typeof name !== "string" ||
            typeof realm !== "string" ||
            typeof region !== "string"
          ) {
            throw new Error("ranking_identity_malformed");
          }
          const identity = { id, name, realm, region };
          const existing = identities.get(id);
          if (
            existing &&
            (existing.name !== name ||
              existing.realm !== realm ||
              existing.region !== region)
          ) {
            throw new Error("ranking_identity_mismatch");
          }
          identities.set(id, identity);
        }
      }
    }
  }
  return [...identities.values()];
}

export function validateRankingIdentities(
  rankings: unknown,
  canonicalCharacters: ReadonlyMap<number, unknown>
): void {
  const report = record(record(record(rankings)?.data)?.reportData)?.report;
  const actors = record(record(report)?.masterData)?.actors;
  if (!Array.isArray(actors)) throw new Error("ranking_identity_malformed");

  for (const identity of rankingIdentities(rankings)) {
    const character = record(canonicalCharacters.get(identity.id));
    const server = character && record(character.server);
    const region = server && record(server.region);
    if (!character || !server || !region) {
      throw new Error("ranking_identity_missing_character");
    }
    if (character.id !== identity.id)
      throw new Error("ranking_identity_id_mismatch");
    if (
      typeof character.name !== "string" ||
      normalizedIdentityPart(character.name) !==
        normalizedIdentityPart(identity.name)
    ) {
      throw new Error("ranking_identity_name_mismatch");
    }
    if (
      typeof server.slug !== "string" ||
      normalizedRealm(server.slug) !== normalizedRealm(identity.realm)
    ) {
      throw new Error("ranking_identity_realm_mismatch");
    }
    if (
      typeof region.slug !== "string" ||
      normalizedIdentityPart(region.slug) !==
        normalizedIdentityPart(identity.region)
    ) {
      throw new Error("ranking_identity_region_mismatch");
    }
    const matchingActors = actors.filter((value) => {
      const actor = record(value);
      return (
        actor?.type === "Player" &&
        typeof actor.name === "string" &&
        typeof actor.server === "string" &&
        normalizedIdentityPart(actor.name) ===
          normalizedIdentityPart(character.name as string) &&
        normalizedRealm(actor.server) === normalizedRealm(server.slug as string)
      );
    });
    if (matchingActors.length !== 1) {
      throw new Error("ranking_identity_non_unique_actor");
    }
  }
}

const MAX_CHARACTER_IDENTITY_LOOKUPS = 50;

function characterIdentityQuery(
  identities: readonly RankingCharacterIdentity[]
): string {
  const selections = identities
    .map(
      (identity, index) =>
        `character${index}: character(id: $character${index}) { id name server { slug region { slug } } }`
    )
    .join("\n");
  const variables = identities
    .map((_, index) => `$character${index}: Int!`)
    .join(", ");
  return `query RankingCharacterIdentities(${variables}) { characterData { ${selections} } }`;
}

const rateLimitQuery = `
  query RateLimitSample {
    rateLimitData { pointsSpentThisHour }
  }
`;

const rankingsQuery = `
  query ReportFightRankingsContract(
    $code: String!
    $fightIDs: [Int!]!
    $encounterID: Int!
    $difficulty: Int!
  ) {
    reportData {
      report(code: $code) {
        code
        archiveStatus { isArchived isAccessible archiveDate }
        masterData { actors { id gameID name server type } }
        damage: rankings(
          compare: Rankings
          difficulty: $difficulty
          encounterID: $encounterID
          fightIDs: $fightIDs
          playerMetric: dps
          timeframe: Historical
        )
        healing: rankings(
          compare: Rankings
          difficulty: $difficulty
          encounterID: $encounterID
          fightIDs: $fightIDs
          playerMetric: hps
          timeframe: Historical
        )
        bossDamage: rankings(
          compare: Rankings
          difficulty: $difficulty
          encounterID: $encounterID
          fightIDs: $fightIDs
          playerMetric: bossdps
          timeframe: Historical
        )
      }
    }
  }
`;

function environmentCredential(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("missing_warcraft_logs_credential");
  return value;
}

async function accessToken(
  clientId: string,
  clientSecret: string
): Promise<string> {
  const response = await fetch("https://www.warcraftlogs.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error("warcraft_logs_token_request_failed");

  const body = record(await response.json());
  const token = body?.access_token;
  if (typeof token !== "string" || !token) {
    throw new Error("warcraft_logs_token_response_invalid");
  }
  return token;
}

async function graphql(
  token: string,
  query: string,
  variables: Record<string, string | number | readonly number[]> = {}
): Promise<unknown> {
  const response = await fetch("https://www.warcraftlogs.com/api/v2/client", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error("warcraft_logs_graphql_request_failed");

  const body = await response.json();
  if (Array.isArray(record(body)?.errors)) {
    throw new Error("warcraft_logs_graphql_response_invalid");
  }
  return body;
}

function pointsSpent(value: unknown): number {
  const data = record(value)?.data;
  const rateLimitData = record(data)?.rateLimitData;
  const points = record(rateLimitData)?.pointsSpentThisHour;
  if (typeof points !== "number" || !Number.isFinite(points)) {
    throw new Error("warcraft_logs_rate_limit_response_invalid");
  }
  return points;
}

async function run(): Promise<void> {
  const options = parseContractProbeOptions(process.argv.slice(2));
  const token = await accessToken(
    environmentCredential("WARCRAFT_LOGS_CLIENT_ID"),
    environmentCredential("WARCRAFT_LOGS_CLIENT_SECRET")
  );
  const before = pointsSpent(await graphql(token, rateLimitQuery));
  const rankings = await graphql(token, rankingsQuery, {
    code: options.reportCode,
    fightIDs: [options.fightId],
    encounterID: options.encounterId,
    difficulty: options.difficulty
  });
  const identities = rankingIdentities(rankings);
  if (identities.length > MAX_CHARACTER_IDENTITY_LOOKUPS) {
    throw new Error("ranking_identity_lookup_limit");
  }
  if (identities.length) {
    const identityResponse = await graphql(
      token,
      characterIdentityQuery(identities),
      Object.fromEntries(
        identities.map((identity, index) => [`character${index}`, identity.id])
      )
    );
    const identityData = record(record(identityResponse)?.data)?.characterData;
    const canonicalCharacters = new Map(
      identities.map((identity, index) => [
        identity.id,
        record(identityData)?.[`character${index}`]
      ])
    );
    validateRankingIdentities(rankings, canonicalCharacters);
  }
  const after = pointsSpent(await graphql(token, rateLimitQuery));

  console.log(
    JSON.stringify({
      rankings: sanitizeRankingsFixture(rankings),
      pointsSpent: { before, after, delta: after - before }
    })
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void run();
}
