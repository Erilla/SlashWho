import type { BlizzardGateway } from "@slashwho/blizzard";
import type { FingerprintGateway } from "@slashwho/domain";

export function createBlizzardFingerprintAdapter(
  gateway: BlizzardGateway,
  options: {
    requestCap: number;
    recordRequest: () => Promise<void>;
    onRateLimited?: () => void;
  }
): FingerprintGateway {
  let requestsUsed = 0;

  async function recordProfileRequest(): Promise<void> {
    if (requestsUsed >= options.requestCap) {
      throw Object.assign(new Error("fingerprint_cap_reached"), {
        kind: "fingerprint_cap_reached"
      });
    }
    await options.recordRequest();
    requestsUsed += 1;
  }

  async function request<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "kind" in error &&
        (error as { kind?: unknown }).kind === "transient" &&
        (error as { status?: unknown }).status === 429
      ) {
        options.onRateLimited?.();
      }
      throw error;
    }
  }

  return {
    getGuildRoster: (root, signal) =>
      request(() => gateway.getGuildRoster(root, signal, recordProfileRequest)),
    getAchievementFingerprint: (key, signal) =>
      request(() =>
        gateway.getAchievementFingerprint(key, signal, recordProfileRequest)
      )
  };
}
