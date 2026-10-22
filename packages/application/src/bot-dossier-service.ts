import type {
  BotCreateDossierOutcome,
  BotCreateDossierResponse,
  BotDossierState
} from "@slashwho/contracts";
import type { Repositories } from "@slashwho/database";
import {
  canonicalCharacterId,
  parseRaiderIoCharacterUrl,
  toRaiderIoUrl,
  type CharacterKey,
  type RaiderIoCharacter
} from "@slashwho/domain";

import type {
  ApplicantDossierService,
  StoredDossierRead,
  StoredDossierStatus
} from "./applicant-dossier-service";
import { botDossierStatusOf } from "./bot-dossier-summary";
import type { ApplicationConfig } from "./config";
import type { MeasurementScope } from "./measurement";
import type { CreateSearchResult, SearchService } from "./search-service";

export type CreateBotDossierResult =
  | {
      kind: "created";
      status: 200 | 202;
      body: BotCreateDossierResponse;
    }
  | { kind: "invalid"; code: "invalid_character_url" }
  | { kind: "not_found"; code: "character_not_found" }
  | { kind: "suppressed"; code: "suppressed_character" }
  | {
      kind: "rate_limited";
      retryAfterSeconds: number;
      root: CharacterKey;
      outcomes: BotCreateDossierOutcome[];
    }
  | { kind: "failed"; code: "search_failed" | "upstream_unavailable" };

export type AddBotDossierCharacterResult =
  | { kind: "linked"; jobId?: string }
  | { kind: "invalid"; code: "invalid_character_url" }
  | { kind: "not_found"; code: "character_not_found" }
  | { kind: "suppressed"; code: "suppressed_character" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "failed"; code: "search_failed" | "upstream_unavailable" };

export type BotRefreshResult =
  | {
      kind: "refreshed";
      mode: "full" | "light";
      lastCollectedAt: Date | null;
    }
  | { kind: "not_found" };

export interface BotDossierService {
  create(
    input: {
      characters: readonly string[];
      headers: Pick<Headers, "get">;
      correlationId?: string | undefined;
    },
    scope?: MeasurementScope
  ): Promise<CreateBotDossierResult>;
  addCharacter(
    root: CharacterKey,
    input: {
      characterUrl: string;
      headers: Pick<Headers, "get">;
      correlationId?: string | undefined;
    },
    scope?: MeasurementScope
  ): Promise<AddBotDossierCharacterResult>;
  status(
    key: CharacterKey,
    scope?: MeasurementScope
  ): Promise<StoredDossierStatus>;
  summary(
    key: CharacterKey,
    scope?: MeasurementScope
  ): Promise<StoredDossierRead>;
  refresh(
    key: CharacterKey,
    scope?: MeasurementScope
  ): Promise<BotRefreshResult>;
}

function sameKey(left: CharacterKey, right: CharacterKey): boolean {
  return canonicalCharacterId(left) === canonicalCharacterId(right);
}

function outcomeOf(
  key: CharacterKey,
  result: CreateSearchResult
): BotCreateDossierOutcome {
  switch (result.kind) {
    case "job":
      return {
        key,
        outcome: result.joinedExistingRun ? "existing" : "queued",
        jobId: result.jobId
      };
    case "character":
      return { key, outcome: "existing" };
    case "rate_limited":
      return { key, outcome: "rate_limited" };
    case "not_found":
      return {
        key,
        outcome:
          result.code === "suppressed_character" ? "suppressed" : "not_found"
      };
    case "invalid":
      return { key, outcome: "not_found" };
    case "failed":
    case "unauthorized":
    case "client_ip_unavailable":
      return { key, outcome: "failed" };
  }
}

function ensureCharacter(
  repositories: Pick<Repositories, "characters">,
  profile: RaiderIoCharacter
): Promise<string> {
  return repositories.characters.ensure({
    key: profile.key,
    displayName: profile.displayName,
    className: profile.className,
    level: profile.level,
    raiderIoUrl: toRaiderIoUrl(profile.key)
  });
}

/** Deduplicate by canonical key, preserving first position. */
function declaredCharacters(
  urls: readonly string[]
): { kind: "invalid" } | { kind: "ok"; keys: readonly CharacterKey[] } {
  const keys: CharacterKey[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    let key: CharacterKey;
    try {
      key = parseRaiderIoCharacterUrl(url);
    } catch {
      return { kind: "invalid" };
    }
    const id = canonicalCharacterId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push(key);
  }
  return keys.length === 0 ? { kind: "invalid" } : { kind: "ok", keys };
}

export function createBotDossierService(options: {
  repositories: Pick<
    Repositories,
    | "characters"
    | "manualConnections"
    | "suppressions"
    | "evidence"
    | "snapshots"
    | "runs"
  >;
  search: Pick<SearchService, "create">;
  dossiers: Pick<
    ApplicantDossierService,
    "readStored" | "readStatus" | "refreshCharacter"
  >;
  config: ApplicationConfig;
}): BotDossierService {
  return {
    async create(input, scope) {
      const declared = declaredCharacters(input.characters);
      if (declared.kind === "invalid") {
        return { kind: "invalid", code: "invalid_character_url" };
      }
      const [root, ...others] = declared.keys;
      if (!root) return { kind: "invalid", code: "invalid_character_url" };

      const rootResult = await options.search.create(
        {
          characterUrl: toRaiderIoUrl(root),
          headers: input.headers,
          ...(input.correlationId === undefined
            ? {}
            : { correlationId: input.correlationId })
        },
        scope
      );
      const rootOutcome = outcomeOf(root, rootResult);
      if (rootOutcome.outcome === "rate_limited") {
        return {
          kind: "rate_limited",
          retryAfterSeconds:
            rootResult.kind === "rate_limited"
              ? rootResult.retryAfterSeconds
              : 1,
          root,
          outcomes: [rootOutcome]
        };
      }
      if (rootOutcome.outcome === "suppressed") {
        return { kind: "suppressed", code: "suppressed_character" };
      }
      if (rootOutcome.outcome === "not_found") {
        return { kind: "not_found", code: "character_not_found" };
      }
      if (rootOutcome.outcome === "failed") {
        return {
          kind: "failed",
          code: rootResult.kind === "failed" ? rootResult.code : "search_failed"
        };
      }
      // The root row exists on the fresh path; on the queued path the search
      // returned the profile it read, so no second Raider.IO call is made.
      if (rootResult.kind === "job") {
        await ensureCharacter(options.repositories, rootResult.profile);
      }

      const outcomes: BotCreateDossierOutcome[] = [rootOutcome];
      let anyQueued = rootOutcome.outcome === "queued";
      let retryAfterSeconds: number | undefined;

      for (const key of others) {
        const result = await options.search.create(
          {
            characterUrl: toRaiderIoUrl(key),
            headers: input.headers,
            ...(input.correlationId === undefined
              ? {}
              : { correlationId: input.correlationId })
          },
          scope
        );
        const outcome = outcomeOf(key, result);
        if (outcome.outcome === "queued" || outcome.outcome === "existing") {
          // Written on every accepted character, including a replay that
          // joined an existing run: if the process died between the enqueue and
          // this write, the retry must repair the missing link.
          await options.repositories.manualConnections.add(root, key, {
            origin: "bot"
          });
          if (outcome.outcome === "queued") anyQueued = true;
        } else if (outcome.outcome === "rate_limited") {
          const retry =
            result.kind === "rate_limited" ? result.retryAfterSeconds : 1;
          retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, retry);
        }
        outcomes.push(outcome);
      }

      const status = botDossierStatusOf(
        await options.dossiers.readStatus(root, scope)
      );
      const state: BotDossierState = status?.state ?? "collecting";
      return {
        kind: "created",
        status: anyQueued || retryAfterSeconds !== undefined ? 202 : 200,
        body: {
          root,
          state,
          snapshotId: status?.snapshotId ?? null,
          lastCollectedAt: status?.lastCollectedAt ?? null,
          evidenceRunIds: status?.evidenceRunIds ?? [],
          outcomes,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
        }
      };
    },

    async addCharacter(root, input, scope) {
      let target: CharacterKey;
      try {
        target = parseRaiderIoCharacterUrl(input.characterUrl);
      } catch {
        return { kind: "invalid", code: "invalid_character_url" };
      }
      if (sameKey(root, target)) {
        return { kind: "invalid", code: "invalid_character_url" };
      }
      const at = new Date();
      if (await options.repositories.suppressions.isActive(root, at)) {
        return { kind: "suppressed", code: "suppressed_character" };
      }
      if (!(await options.repositories.characters.find(root))) {
        return { kind: "not_found", code: "character_not_found" };
      }
      if (await options.repositories.suppressions.isActive(target, at)) {
        return { kind: "suppressed", code: "suppressed_character" };
      }
      const existing = (
        await options.repositories.manualConnections.list(root)
      ).some((connection) => sameKey(connection.key, target));
      // A link with completed evidence needs no search. A link without it is a
      // retry after a rate-limited create, so the search must be resumed.
      if (
        existing &&
        (await options.repositories.evidence.getCompleted(target))
      ) {
        return { kind: "linked" };
      }
      const result = await options.search.create(
        {
          characterUrl: toRaiderIoUrl(target),
          headers: input.headers,
          ...(input.correlationId === undefined
            ? {}
            : { correlationId: input.correlationId })
        },
        scope
      );
      switch (result.kind) {
        case "job":
        case "character":
          await options.repositories.manualConnections.add(root, target, {
            origin: "bot"
          });
          return {
            kind: "linked",
            ...(result.kind === "job" ? { jobId: result.jobId } : {})
          };
        case "rate_limited":
          return {
            kind: "rate_limited",
            retryAfterSeconds: result.retryAfterSeconds
          };
        case "not_found":
          return result.code === "suppressed_character"
            ? { kind: "suppressed", code: "suppressed_character" }
            : { kind: "not_found", code: "character_not_found" };
        case "invalid":
          return { kind: "invalid", code: "invalid_character_url" };
        case "failed":
          return { kind: "failed", code: result.code };
        case "unauthorized":
        case "client_ip_unavailable":
          return { kind: "failed", code: "search_failed" };
      }
    },

    status(key, scope) {
      return options.dossiers.readStatus(key, scope);
    },

    summary(key, scope) {
      return options.dossiers.readStored(key, scope);
    },

    async refresh(key, scope) {
      const at = new Date();
      if (await options.repositories.suppressions.isActive(key, at)) {
        return { kind: "not_found" };
      }
      if (!(await options.repositories.characters.find(key))) {
        return { kind: "not_found" };
      }
      const result = await options.dossiers.refreshCharacter(key, scope);
      return {
        kind: "refreshed",
        mode: result.mode === "light" ? "light" : "full",
        lastCollectedAt: result.lastCollectedAt
      };
    }
  };
}
