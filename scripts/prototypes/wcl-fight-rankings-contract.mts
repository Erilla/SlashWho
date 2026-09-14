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
