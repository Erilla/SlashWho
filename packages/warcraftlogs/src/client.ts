import { supportedRegions, type CharacterKey } from "@slashwho/domain";

import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsGateway,
  WarcraftLogsIdentityResult,
  WarcraftLogsLimitation,
  WarcraftLogsReportResult
} from "./types";

const MYTHIC_DIFFICULTY = 5;
// Nested actor/fight selections make a 100-report page exceed WCL's
// 50,000-point query complexity ceiling. Ten reports fit that limit.
const REPORTS_PER_PAGE = 10;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

const resolveCharacterQuery = `
  query ResolveCharacter($name: String!, $realm: String!, $region: String!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        name
        server {
          slug
          region { slug }
        }
      }
    }
  }
`;

const recentReportsQuery = `
  query RecentReports($name: String!, $realm: String!, $region: String!, $page: Int!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        server { normalizedName }
        recentReports(limit: ${REPORTS_PER_PAGE}, page: $page) {
          data {
            code
            startTime
            zone { id name }
            masterData { actors { id name server type } }
            fights {
              id
              encounterID
              name
              startTime
              kill
              difficulty
              friendlyPlayers
            }
          }
          has_more_pages
        }
      }
    }
  }
`;

export type CreateWarcraftLogsClientOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  clientId: string;
  clientSecret: string;
  /** Overrides the Warcraft Logs origin for deterministic local integration tests. */
  baseUrl?: string;
}>;

type AccessToken = Readonly<{
  value: string;
  expiresAt: number;
}>;

type GraphqlSuccess = Readonly<{ kind: "success"; value: unknown }>;
type GraphqlResult = GraphqlSuccess | WarcraftLogsLimitation;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function nonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function validTimestampMilliseconds(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DATE_MILLISECONDS
    ? value
    : null;
}

function validCharacterKey(value: CharacterKey): CharacterKey {
  const valid =
    supportedRegions.includes(value.region) &&
    /^[a-z0-9-]+$/.test(value.realm) &&
    /^[\p{L}\p{M}'-]+$/u.test(value.name) &&
    value.realm === value.realm.toLocaleLowerCase("en-US") &&
    value.name === value.name.toLocaleLowerCase("en-US");
  if (!valid) throw new Error("invalid_character_key");
  return value;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : undefined;
}

function responseLimitation(response: Response): WarcraftLogsLimitation {
  if (response.status === 404) return { kind: "limitation", code: "not_found" };
  if (response.status === 401 || response.status === 403) {
    return { kind: "limitation", code: "private" };
  }
  if (response.status === 429) {
    const retryAfter = retryAfterMs(response);
    return {
      kind: "limitation",
      code: "rate_limited",
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter })
    };
  }
  return { kind: "limitation", code: "unavailable" };
}

function graphQlErrorLimitation(value: unknown): WarcraftLogsLimitation | null {
  const envelope = record(value);
  const errors = envelope && envelope.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;

  const error = record(errors[0]);
  const message =
    error && nonEmptyString(error.message)?.toLocaleLowerCase("en-US");
  const extensions = error && record(error.extensions);
  const code =
    extensions && nonEmptyString(extensions.code)?.toLocaleUpperCase("en-US");
  if (code === "NOT_FOUND" || message?.includes("not found")) {
    return { kind: "limitation", code: "not_found" };
  }
  if (
    code === "FORBIDDEN" ||
    code === "UNAUTHORIZED" ||
    message?.includes("private") ||
    message?.includes("forbidden") ||
    message?.includes("not authorized")
  ) {
    return { kind: "limitation", code: "private" };
  }
  return { kind: "limitation", code: "unavailable" };
}

function canonicalIdentity(value: unknown): WarcraftLogsIdentityResult {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  const character = characterData && characterData.character;
  if (character === null) return { kind: "limitation", code: "not_found" };

  const entry = record(character);
  const server = entry && record(entry.server);
  const region = server && record(server.region);
  const displayName = entry && nonEmptyString(entry.name);
  const realm = server && nonEmptyString(server.slug);
  const regionSlug = region && nonEmptyString(region.slug);
  if (!displayName || !realm || !regionSlug) {
    return { kind: "limitation", code: "schema_drift" };
  }

  const key = {
    region: regionSlug.toLocaleLowerCase("en-US"),
    realm: realm.toLocaleLowerCase("en-US"),
    name: displayName.toLocaleLowerCase("en-US")
  } as CharacterKey;
  try {
    validCharacterKey(key);
  } catch {
    return { kind: "limitation", code: "schema_drift" };
  }
  return { kind: "identity", key, displayName };
}

function firstKillReports(
  value: unknown,
  requestedKey: CharacterKey
): WarcraftLogsReportResult {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  const character = characterData && characterData.character;
  if (character === null) return { kind: "limitation", code: "not_found" };

  const entry = record(character);
  const characterServer = entry && record(entry.server);
  const normalizedRealm =
    characterServer && nonEmptyString(characterServer.normalizedName);
  const recentReports = entry && record(entry.recentReports);
  const reports = recentReports && recentReports.data;
  const hasMorePages = recentReports && recentReports.has_more_pages;
  if (
    !normalizedRealm ||
    !Array.isArray(reports) ||
    typeof hasMorePages !== "boolean"
  ) {
    return { kind: "limitation", code: "schema_drift" };
  }

  const earliest = new Map<number, WarcraftLogsFirstKillEvidence>();
  for (const reportValue of reports) {
    const report = record(reportValue);
    const code = report && nonEmptyString(report.code);
    const reportStartTime =
      report && validTimestampMilliseconds(report.startTime);
    const fights = report && report.fights;
    const zone = report && record(report.zone);
    const raidId = zone && positiveInteger(zone.id);
    const raidName = zone && nonEmptyString(zone.name);
    const masterData = report && record(report.masterData);
    const actors = masterData && masterData.actors;
    if (
      !code ||
      reportStartTime === null ||
      !raidId ||
      !raidName ||
      !Array.isArray(actors) ||
      !Array.isArray(fights)
    ) {
      return { kind: "limitation", code: "schema_drift" };
    }

    const participantIds = new Set<number>();
    for (const actorValue of actors) {
      const actor = record(actorValue);
      if (actor?.type !== "Player") continue;
      const actorId = actor && positiveInteger(actor.id);
      const name = actor && nonEmptyString(actor.name);
      const server = actor && nonEmptyString(actor.server);
      if (!actorId || !name) {
        return { kind: "limitation", code: "schema_drift" };
      }
      // A player without a realm cannot establish this character's identity.
      // Ignore that actor rather than discarding other attributable kills.
      if (!server) continue;
      if (
        name.toLocaleLowerCase("en-US") === requestedKey.name &&
        server.toLocaleLowerCase("en-US") ===
          normalizedRealm.toLocaleLowerCase("en-US")
      ) {
        participantIds.add(actorId);
      }
    }

    for (const fightValue of fights) {
      const fight = record(fightValue);
      const id = fight && positiveInteger(fight.id);
      const encounterId = fight && nonNegativeInteger(fight.encounterID);
      const bossName = fight && nonEmptyString(fight.name);
      const fightStartTime =
        fight && validTimestampMilliseconds(fight.startTime);
      const killed = fight && fight.kill;
      const difficulty = fight && fight.difficulty;
      const friendlyPlayers = fight && fight.friendlyPlayers;
      if (!id || encounterId === null || fightStartTime === null) {
        return { kind: "limitation", code: "schema_drift" };
      }
      // Warcraft Logs represents trash pulls with encounterID 0. They have no
      // boss identity and must not turn an otherwise valid report into schema
      // drift or dossier evidence.
      if (encounterId === 0) continue;
      if (
        typeof killed !== "boolean" ||
        !Number.isSafeInteger(difficulty) ||
        !Array.isArray(friendlyPlayers) ||
        friendlyPlayers.some((player) => !positiveInteger(player))
      ) {
        return { kind: "limitation", code: "schema_drift" };
      }
      if (!bossName) return { kind: "limitation", code: "schema_drift" };
      if (
        !killed ||
        difficulty !== MYTHIC_DIFFICULTY ||
        !friendlyPlayers.some((player) => participantIds.has(player))
      ) {
        continue;
      }

      const killedAtMilliseconds = reportStartTime + fightStartTime;
      if (
        !Number.isSafeInteger(killedAtMilliseconds) ||
        killedAtMilliseconds > MAX_DATE_MILLISECONDS
      ) {
        return { kind: "limitation", code: "schema_drift" };
      }
      const killedAt = new Date(killedAtMilliseconds).toISOString();
      const candidate: WarcraftLogsFirstKillEvidence = {
        raidId: String(raidId),
        raidName,
        bossId: String(encounterId),
        bossName,
        bossOrder: encounterId,
        isFinalBoss: false,
        killedAt,
        reportUrl: `https://www.warcraftlogs.com/reports/${encodeURIComponent(code)}`,
        fightUrl: `https://www.warcraftlogs.com/reports/${encodeURIComponent(code)}#fight=${id}`,
        guild: null,
        historicWorldRank: null
      };
      const current = earliest.get(encounterId);
      if (
        !current ||
        candidate.killedAt < current.killedAt ||
        (candidate.killedAt === current.killedAt &&
          candidate.fightUrl < current.fightUrl)
      ) {
        earliest.set(encounterId, candidate);
      }
    }
  }

  return {
    kind: "evidence",
    kills: [...earliest.values()].sort(
      (a, b) =>
        a.bossOrder - b.bossOrder ||
        a.killedAt.localeCompare(b.killedAt) ||
        a.fightUrl.localeCompare(b.fightUrl)
    )
  };
}

function hasMoreReportPages(value: unknown): boolean | null {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  const character = characterData && record(characterData.character);
  const recentReports = character && record(character.recentReports);
  return recentReports && typeof recentReports.has_more_pages === "boolean"
    ? recentReports.has_more_pages
    : null;
}

export function createWarcraftLogsClient(
  options: CreateWarcraftLogsClientOptions
): WarcraftLogsGateway {
  if (!options.clientId || !options.clientSecret) {
    throw new Error("invalid_client_credentials");
  }
  const baseUrl = options.baseUrl ? new URL(options.baseUrl) : undefined;
  if (baseUrl && !/^https?:$/.test(baseUrl.protocol)) {
    throw new Error("invalid_base_url");
  }
  let cachedToken: AccessToken | undefined;

  function tokenUrl(): URL {
    return new URL("/oauth/token", baseUrl ?? "https://www.warcraftlogs.com");
  }

  function graphqlUrl(): URL {
    return new URL("/api/v2/client", baseUrl ?? "https://www.warcraftlogs.com");
  }

  async function accessToken(
    signal?: AbortSignal
  ): Promise<string | WarcraftLogsLimitation> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      return cachedToken.value;
    }

    let response: Response;
    try {
      response = await options.fetch(tokenUrl().toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(
            `${options.clientId}:${options.clientSecret}`
          ).toString("base64")}`
        },
        body: "grant_type=client_credentials",
        signal
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "unavailable" };
    }

    signal?.throwIfAborted();
    if (!response.ok) return responseLimitation(response);
    try {
      const body = record(await response.json());
      signal?.throwIfAborted();
      const value = body && nonEmptyString(body.access_token);
      const expiresIn = body && nonNegativeFiniteNumber(body.expires_in);
      if (!value || expiresIn === null || expiresIn <= 0) {
        return { kind: "limitation", code: "schema_drift" };
      }
      cachedToken = {
        value,
        expiresAt: Date.now() + Math.max(0, expiresIn * 1_000 - 60_000)
      };
      return value;
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "schema_drift" };
    }
  }

  async function graphql(
    query: string,
    variables: Record<string, string | number>,
    signal?: AbortSignal
  ): Promise<GraphqlResult> {
    const token = await accessToken(signal);
    if (typeof token !== "string") return token;
    signal?.throwIfAborted();

    let response: Response;
    try {
      response = await options.fetch(graphqlUrl().toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables }),
        signal
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "unavailable" };
    }

    signal?.throwIfAborted();
    if (!response.ok) return responseLimitation(response);
    try {
      const body = await response.json();
      signal?.throwIfAborted();
      return graphQlErrorLimitation(body) ?? { kind: "success", value: body };
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "schema_drift" };
    }
  }

  async function resolveCharacter(
    requestedKey: CharacterKey,
    signal?: AbortSignal
  ): Promise<WarcraftLogsIdentityResult> {
    const key = validCharacterKey(requestedKey);
    const result = await graphql(
      resolveCharacterQuery,
      { name: key.name, realm: key.realm, region: key.region },
      signal
    );
    return result.kind === "success" ? canonicalIdentity(result.value) : result;
  }

  async function getFirstKillReports(
    requestedKey: CharacterKey,
    options: Readonly<{ requestCap: number; signal?: AbortSignal }>
  ): Promise<WarcraftLogsReportResult> {
    const key = validCharacterKey(requestedKey);
    if (!Number.isSafeInteger(options.requestCap) || options.requestCap <= 0) {
      return { kind: "limitation", code: "request_cap" };
    }

    const earliest = new Map<string, WarcraftLogsFirstKillEvidence>();
    const partial = (
      limitation: WarcraftLogsLimitation
    ): WarcraftLogsReportResult =>
      earliest.size
        ? { kind: "evidence", kills: [...earliest.values()], limitation }
        : limitation;
    for (let page = 1; page <= options.requestCap; page++) {
      const result = await graphql(
        recentReportsQuery,
        { name: key.name, realm: key.realm, region: key.region, page },
        options.signal
      ).catch((error: unknown) => {
        if (options.signal?.reason?.name !== "TimeoutError") throw error;
        return { kind: "limitation" as const, code: "unavailable" as const };
      });
      if (result.kind !== "success") return partial(result);

      const normalized = firstKillReports(result.value, key);
      if (normalized.kind === "limitation") return partial(normalized);
      for (const kill of normalized.kills) {
        const identifier = `${kill.raidId}\u0000${kill.bossId}`;
        const current = earliest.get(identifier);
        if (
          !current ||
          kill.killedAt < current.killedAt ||
          (kill.killedAt === current.killedAt &&
            kill.fightUrl < current.fightUrl)
        ) {
          earliest.set(identifier, kill);
        }
      }

      const hasMorePages = hasMoreReportPages(result.value);
      if (hasMorePages === null) {
        return { kind: "limitation", code: "schema_drift" };
      }
      if (!hasMorePages) {
        return {
          kind: "evidence",
          kills: [...earliest.values()].sort(
            (a, b) =>
              a.raidId.localeCompare(b.raidId) ||
              a.bossOrder - b.bossOrder ||
              a.killedAt.localeCompare(b.killedAt) ||
              a.fightUrl.localeCompare(b.fightUrl)
          )
        };
      }
    }
    return partial({ kind: "limitation", code: "request_cap" });
  }

  return { resolveCharacter, getFirstKillReports };
}
