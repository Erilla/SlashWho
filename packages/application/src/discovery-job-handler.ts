import type { Repositories } from "@slashwho/database";
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

export function createDiscoveryJobHandler(options: DiscoveryJobHandlerOptions) {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 1_800_000;
  const maxJobLifetimeMs = options.maxJobLifetimeMs ?? 1_800_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const negativeCacheTtlMs = options.negativeCacheTtlMs ?? 300_000;

  return {
    async execute(runId: string): Promise<void> {
      const run = await options.repositories.runs.find(runId);
      if (!run) throw new Error("discovery_run_not_found");
      if (run.status === "complete" || run.status === "failed") return;

      const executionTime = now();
      if (
        executionTime.getTime() - run.createdAt.getTime() >=
        maxJobLifetimeMs
      ) {
        await options.repositories.runs.fail(runId, "upstream_unavailable");
        return;
      }

      await options.repositories.runs.markRunning(runId);
      const outcome = await discoverCharacter(run.rootKey, options.gateway, {
        requestCap: options.requestCap,
        isSuppressed: (key) => options.repositories.suppressions.isActive(key)
      });

      if (outcome.kind === "snapshot") {
        await options.repositories.snapshots.create({
          runId,
          rootKey: run.rootKey,
          state: outcome.state,
          limitationCode:
            outcome.state === "partial" ? outcome.limitationCode : null,
          refreshedAt: now(),
          characters: [...outcome.characters]
        });
        return;
      }

      if (!outcome.retryable) {
        if (outcome.code === "character_not_found") {
          await options.repositories.negativeCache.put(
            run.rootKey,
            new Date(now().getTime() + negativeCacheTtlMs)
          );
          await options.repositories.runs.fail(runId, "character_not_found");
          return;
        }
        await options.repositories.runs.fail(runId, "search_failed");
        return;
      }

      const attempt = run.attempt + 1;
      const failureTime = now();
      const remainingLifetimeMs = Math.max(
        0,
        run.createdAt.getTime() + maxJobLifetimeMs - failureTime.getTime()
      );
      const exponentialDelay =
        baseRetryDelayMs * 2 ** Math.max(0, attempt - 1) * (0.5 + random() / 2);
      const retryCeilingSeconds = Math.floor(
        Math.min(maxRetryDelayMs, remainingLifetimeMs) / 1_000
      );
      const requestedRetrySeconds = Math.max(
        1,
        Math.ceil(Math.max(exponentialDelay, outcome.retryAfterMs ?? 0) / 1_000)
      );
      const retryAfterMs =
        Math.min(retryCeilingSeconds, requestedRetrySeconds) * 1_000;

      if (attempt >= maxAttempts || retryCeilingSeconds === 0) {
        await options.repositories.runs.fail(runId, "upstream_unavailable");
        return;
      }
      await options.repositories.runs.markRetrying(
        runId,
        attempt,
        new Date(failureTime.getTime() + retryAfterMs)
      );
      throw retryableError(retryAfterMs);
    }
  };
}

export type DiscoveryJobHandler = ReturnType<typeof createDiscoveryJobHandler>;
