import type { DiscoveryWorkContext, Repositories } from "@slashwho/database";
import { discoverCharacter, type RaiderIoGateway } from "@slashwho/domain";

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
    if (attempt >= attemptLimit || remainingLifetimeMs === 0) return null;

    const retryAfterMs = Math.min(
      maxRetryDelayMs,
      remainingLifetimeMs,
      Math.max(1_000, Math.ceil(requestedDelayMs / 1_000) * 1_000)
    );
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

      try {
        context.signal.throwIfAborted();
        const executionTime = now();
        if (
          executionTime.getTime() - run.createdAt.getTime() >=
          maxJobLifetimeMs
        ) {
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
          await options.repositories.runs.fail(runId, "upstream_unavailable");
          return;
        }

        if (outcome.kind === "snapshot") {
          context.signal.throwIfAborted();
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
          await options.repositories.runs.fail(runId, "upstream_unavailable");
          return;
        }
        await options.repositories.runs.markRetrying(
          runId,
          context.attempt,
          schedule.nextRetryAt
        );
        throw retryableError(schedule.retryAfterMs);
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        if (isRetryableDiscoveryError(error)) throw error;

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
          await options.repositories.runs.fail(runId, "search_failed");
          throw error;
        }

        await options.repositories.runs.markRetrying(
          runId,
          context.attempt,
          schedule.nextRetryAt
        );
        throw retryableError(schedule.retryAfterMs);
      }
    }
  };
}

export type DiscoveryJobHandler = ReturnType<typeof createDiscoveryJobHandler>;
