import type { BlizzardGateway } from "@slashwho/blizzard";
import type { FingerprintGateway } from "@slashwho/domain";

export function createBlizzardFingerprintAdapter(
  gateway: BlizzardGateway,
  recordRequest: () => Promise<void>
): FingerprintGateway {
  async function request<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      await recordRequest();
    }
  }

  return {
    getGuildRoster: (root, signal) =>
      request(() => gateway.getGuildRoster(root, signal)),
    getAchievementFingerprint: (key, signal) =>
      request(() => gateway.getAchievementFingerprint(key, signal))
  };
}
