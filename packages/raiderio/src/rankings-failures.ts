import { isUpstreamFailure } from "@slashwho/upstream-http";
import type { MythicBossRankingsResult, RankingsFailureCode } from "./types";

export class GuildNotFound extends Error {
  constructor() {
    super("guild_not_found");
  }
}

type Limitation = Extract<MythicBossRankingsResult, { kind: "limitation" }>;

export function rankingsLimitation(error: unknown): Limitation {
  if (error instanceof GuildNotFound) {
    return {
      kind: "limitation",
      code: "not_found",
      guildNotFound: true,
      failureCode: "not_found"
    };
  }
  if (!isUpstreamFailure(error)) {
    return { kind: "limitation", code: "unavailable", failureCode: "network" };
  }
  switch (error.kind) {
    case "not_found":
      return {
        kind: "limitation",
        code: "not_found",
        failureCode: "not_found"
      };
    case "forbidden":
      return { kind: "limitation", code: "private", failureCode: "private" };
    case "schema_drift":
      return {
        kind: "limitation",
        code: "schema_drift",
        failureCode: "schema"
      };
    case "transient": {
      const timeout =
        "rankingTimeout" in error && error.rankingTimeout === true;
      const failureCode: RankingsFailureCode =
        error.status === 429 || error.retryAfterMs !== undefined
          ? "throttled"
          : error.status !== undefined
            ? error.status >= 500
              ? "http_5xx"
              : "http_4xx"
            : timeout
              ? "timeout"
              : "network";
      return {
        kind: "limitation",
        code: error.status === 429 ? "rate_limited" : "unavailable",
        failureCode,
        ...(error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: error.retryAfterMs })
      };
    }
  }
}

/** Endpoint-order ties are deliberate; completion order must not settle evidence. */
export function guildPairLimitation(failures: readonly unknown[]): Limitation {
  const real = failures.filter(
    (failure) => !(failure instanceof GuildNotFound)
  );
  if (real.length === 0) return rankingsLimitation(failures[0]);
  const priority = (result: Limitation) => {
    switch (result.failureCode) {
      case "throttled":
        return 0;
      case "http_4xx":
      case "http_5xx":
      case "network":
      case "timeout":
        return 1;
      case "schema":
        return 2;
      case "private":
        return 3;
      default:
        return 4;
    }
  };
  const results = real.map(rankingsLimitation);
  const selected = [...results].sort((a, b) => priority(a) - priority(b))[0]!;
  const delays = results
    .filter((item) => item.failureCode === "throttled")
    .flatMap((item) =>
      item.retryAfterMs === undefined ? [] : [item.retryAfterMs]
    );
  return selected.failureCode === "throttled" && delays.length > 0
    ? { ...selected, retryAfterMs: Math.max(...delays) }
    : selected;
}

/** Caller cancellation cannot wait for a fetch implementation to cooperate. */
export function awaitRankingsPair<T>(
  pending: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
