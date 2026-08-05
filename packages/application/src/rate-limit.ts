import type { RateLimitRepository } from "@slashwho/database";

import type { CallerIdentity } from "./auth";
import type { ApplicationConfig } from "./config";

export type RateLimitDecision = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number | null;
}>;

export type SearchReservationPolicy = Readonly<{
  bucketHash: string;
  limit: number;
  expiresAt: Date;
  at: Date;
}>;

export function createRateLimiter(options: {
  repository: RateLimitRepository;
  config: ApplicationConfig;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  function decision(
    reservation: { allowed: boolean; retryAt: Date | null },
    at: Date
  ): RateLimitDecision {
    return {
      allowed: reservation.allowed,
      retryAfterSeconds: reservation.retryAt
        ? Math.max(
            1,
            Math.ceil((reservation.retryAt.getTime() - at.getTime()) / 1_000)
          )
        : null
    };
  }

  return {
    searchReservation(caller: CallerIdentity): SearchReservationPolicy {
      const at = now();
      return {
        bucketHash: `search:${caller.bucketHash}`,
        limit:
          caller.callerClass === "bot"
            ? options.config.BOT_SEARCHES_PER_HOUR
            : options.config.ANONYMOUS_SEARCHES_PER_HOUR,
        expiresAt: new Date(at.getTime() + 60 * 60 * 1_000),
        at
      };
    },

    async reservePublicRead(
      caller: CallerIdentity
    ): Promise<RateLimitDecision> {
      const at = now();
      const reservation = await options.repository.reserve(
        `read:${caller.bucketHash}`,
        options.config.PUBLIC_READS_PER_MINUTE,
        new Date(at.getTime() + 60 * 1_000),
        at
      );
      return decision(reservation, at);
    },

    retryDecision(
      reservation: { allowed: boolean; retryAt: Date | null },
      at: Date
    ): RateLimitDecision {
      return decision(reservation, at);
    }
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
