import type { CharacterKey } from "@slashwho/domain";

import type { ClientContext } from "./collect/context";
import { collectFirstKillReports } from "./collect/first-kill";
import { getRankedKillReports } from "./collect/ranked-backfill";
import { canonicalIdentity } from "./decode/character";
import { positiveInteger, validCharacterKey } from "./decode/primitives";
import { rateLimitFacts } from "./decode/rate-limit";
import {
  rateLimitQuery,
  resolveCharacterByIdQuery,
  resolveCharacterQuery
} from "./queries";
import { createTransport } from "./transport";
import type {
  WarcraftLogsGateway,
  WarcraftLogsIdentityResult,
  WarcraftLogsRateLimitResult
} from "./types";

export type CreateWarcraftLogsClientOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  clientId: string;
  clientSecret: string;
  /** Overrides the Warcraft Logs origin for deterministic local integration tests. */
  baseUrl?: string;
  onThrottle?(event: { retryAfterMs: number | undefined }): void;
  /** Times each request for `onRequest`. Injected so tests control it. */
  monotonic?: () => number;
}>;

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
  const { graphql } = createTransport({
    fetch: options.fetch,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    ...(baseUrl ? { baseUrl } : {}),
    ...(options.onThrottle ? { onThrottle: options.onThrottle } : {})
  });
  const ctx: ClientContext = {
    graphql,
    monotonic: options.monotonic ?? (() => performance.now()),
    caches: { attendanceWalks: new Map() }
  };

  async function getRateLimit(
    signal?: AbortSignal
  ): Promise<WarcraftLogsRateLimitResult> {
    const result = await graphql(rateLimitQuery, {}, signal);
    return result.kind === "success" ? rateLimitFacts(result.value) : result;
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

  async function resolveCharacterById(
    characterId: number,
    signal?: AbortSignal
  ): Promise<WarcraftLogsIdentityResult> {
    if (positiveInteger(characterId) === null) {
      throw new Error("invalid_character_id");
    }
    const result = await graphql(
      resolveCharacterByIdQuery,
      { id: characterId },
      signal
    );
    if (result.kind !== "success") return result;
    const identity = canonicalIdentity(result.value);
    // The payload must answer for the ID asked about, or a pasted ID would
    // be attached to some other character's name and realm.
    return identity.kind === "identity" && identity.characterId !== characterId
      ? { kind: "limitation", code: "schema_drift" }
      : identity;
  }

  return {
    getRateLimit,
    resolveCharacter,
    resolveCharacterById,
    getRankedKillReports: (key, rankedOptions) =>
      getRankedKillReports(ctx, key, rankedOptions),
    getFirstKillReports: (key, firstKillOptions) =>
      collectFirstKillReports(ctx, key, firstKillOptions)
  };
}
