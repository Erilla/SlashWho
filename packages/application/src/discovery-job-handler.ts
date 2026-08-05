import type { DiscoveryWorkContext, Repositories } from "@slashwho/database";
import { discoverCharacter, type RaiderIoGateway } from "@slashwho/domain";

export type DiscoveryLogger = {
  info(value: Record<string, unknown>): void;
};

export type DiscoveryJobHandlerOptions = {
  repositories: Repositories;
  gateway: RaiderIoGateway;
  requestCap: number;
  now?: () => Date;
  random?: () => number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxJobLifetimeMs?: number;
  maxAttempts?: number;
  negativeCacheTtlMs?: number;
  logger?: DiscoveryLogger;
  monotonic?: () => number;
};

/**
 * One operational record per discovery run. The field set is an allowlist: run
 * identity, the canonical (public) character key, the delivery attempt, and the
 * outcome. Never an owner id, a profile guess, an upstream body, or an IP.
 */
type DiscoveryRunRecord = {
  event: "discovery_run";
  runId: string;
  region: string;
  realm: string;
  name: string;
  attempt: number;
  outcome: string;
  state: string | null;
  limitationCode: string | null;
  characterCount: number;
  durationMs: number;
};

export type RetryableDiscoveryError = Error & {
  retryable: true;
  retryAfterMs: number;
};

function retryableError(retryAfterMs: number): RetryableDiscoveryError {
  return Object.assign(new Error("discovery_retryable"), {
    retryable: true as const,
    retryAfterMs
  });
}

function isRetryableDiscoveryError(
  error: unknown
): error is RetryableDiscoveryError {
  return (
    error instanceof Error &&
    "retryable" in error &&
    error.retryable === true &&
    "retryAfterMs" in error &&
    typeof error.retryAfterMs === "number"
  );
}

export function createDiscoveryJobHandler(options: DiscoveryJobHandlerOptions) {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 1_800_000;
  const maxJobLifetimeMs = options.maxJobLifetimeMs ?? 1_800_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const negativeCacheTtlMs = options.negativeCacheTtlMs ?? 300_000;
  const monotonic = options.monotonic ?? performance.now.bind(performance);

  function retrySchedule(
    createdAt: Date,
    failureTime: Date,
    attempt: number,
    attemptLimit: number,
    requestedDelayMs: number
  ): { retryAfterMs: number; nextRetryAt: Date } | null {
    const remainingLifetimeMs = Math.max(
      0,
      createdAt.getTime() + maxJobLifetimeMs - failureTime.getTime()
    );
    const retryAfterMs = Math.max(
      1_000,
      Math.ceil(Math.min(requestedDelayMs, maxRetryDelayMs) / 1_000) * 1_000
    );
    if (
      attempt >= attemptLimit ||
      retryAfterMs > maxRetryDelayMs ||
      retryAfterMs > remainingLifetimeMs
    ) {
      return null;
    }

    return {
      retryAfterMs,
      nextRetryAt: new Date(failureTime.getTime() + retryAfterMs)
    };
  }

  return {
    async execute(
      runId: string,
      workContext?: DiscoveryWorkContext
    ): Promise<void> {
      let context = workContext;
      if (!context) {
        const existing = await options.repositories.runs.find(runId);
        if (!existing) throw new Error("discovery_run_not_found");
        if (existing.status === "complete" || existing.status === "failed") {
          return;
        }
        context = {
          attempt: existing.attempt + 1,
          maxAttempts,
          signal: new AbortController().signal
        };
      }

      const run = await options.repositories.runs.claim(runId, context.attempt);
      if (!run) return;

      const observedAt = monotonic();
      const record: DiscoveryRunRecord = {
        event: "discovery_run",
        runId,
        region: run.rootKey.region,
        realm: run.rootKey.realm,
        name: run.rootKey.name,
        attempt: context.attempt,
        outcome: "unknown",
        state: null,
        limitationCode: null,
        characterCount: 0,
        durationMs: 0
      };

      try {
        context.signal.throwIfAborted();
        const executionTime = now();
        if (
          executionTime.getTime() - run.createdAt.getTime() >=
          maxJobLifetimeMs
        ) {
          record.outcome = "lifetime_exceeded";
          await options.repositories.runs.fail(runId, "upstream_unavailable");
          return;
        }

        const outcome = await discoverCharacter(run.rootKey, options.gateway, {
          requestCap: options.requestCap,
          isSuppressed: (key) =>
            options.repositories.suppressions.isActive(key),
          signal: context.signal
        });
        context.signal.throwIfAborted();
        const persistenceTime = now();
        if (
          persistenceTime.getTime() - run.createdAt.getTime() >=
          maxJobLifetimeMs
        ) {
          record.outcome = "lifetime_exceeded";
          await options.repositories.runs.fail(runId, "upstream_unavailable");
          return;
        }

        if (outcome.kind === "snapshot") {
          context.signal.throwIfAborted();
          record.outcome = "snapshot";
          record.state = outcome.state;
          record.limitationCode =
            outcome.state === "partial" ? outcome.limitationCode : null;
          record.characterCount = outcome.characters.length;
          await options.repositories.snapshots.create(
            {
              runId,
              rootKey: run.rootKey,
              state: outcome.state,
              limitationCode:
                outcome.state === "partial" ? outcome.limitationCode : null,
              refreshedAt: persistenceTime,
              characters: [...outcome.characters]
            },
            { signal: context.signal }
          );
          return;
        }

        if (!outcome.retryable) {
          record.outcome = outcome.code;
          if (outcome.code === "character_not_found") {
            context.signal.throwIfAborted();
            await options.repositories.negativeCache.putAndFailRun(
              run.rootKey,
              new Date(persistenceTime.getTime() + negativeCacheTtlMs),
              runId,
              { signal: context.signal }
            );
            return;
          }
          await options.repositories.runs.fail(runId, "search_failed");
          return;
        }

        const failureTime = now();
        const exponentialDelay =
          baseRetryDelayMs *
          2 ** Math.max(0, context.attempt - 1) *
          (0.5 + random() / 2);
        const schedule = retrySchedule(
          run.createdAt,
          failureTime,
          context.attempt,
          context.maxAttempts,
          Math.max(exponentialDelay, outcome.retryAfterMs ?? 0)
        );

        if (!schedule) {
          record.outcome = "upstream_unavailable";
          await options.repositories.runs.fail(runId, "upstream_unavailable");
          return;
        }
        record.outcome = "retrying";
        await options.repositories.runs.markRetrying(
          runId,
          context.attempt,
          schedule.nextRetryAt
        );
        throw retryableError(schedule.retryAfterMs);
      } catch (error) {
        if (context.signal.aborted) {
          record.outcome = "cancelled";
          throw context.signal.reason;
        }
        if (isRetryableDiscoveryError(error)) throw error;
        record.outcome = "unexpected_error";

        const current = await options.repositories.runs.find(runId);
        if (current?.status === "complete" || current?.status === "failed") {
          if (current.status === "complete") return;
          throw error;
        }
        const failureTime = now();
        const schedule = retrySchedule(
          run.createdAt,
          failureTime,
          context.attempt,
          context.maxAttempts,
          baseRetryDelayMs * 2 ** Math.max(0, context.attempt - 1)
        );
        if (!schedule) {
          record.outcome = "search_failed";
          await options.repositories.runs.fail(runId, "search_failed");
          throw error;
        }

        record.outcome = "retrying";
        await options.repositories.runs.markRetrying(
          runId,
          context.attempt,
          schedule.nextRetryAt
        );
        throw retryableError(schedule.retryAfterMs);
      } finally {
        if (options.logger) {
          record.durationMs = Math.max(0, Math.round(monotonic() - observedAt));
          options.logger.info({ ...record });
        }
      }
    }
  };
}

export type DiscoveryJobHandler = ReturnType<typeof createDiscoveryJobHandler>;
