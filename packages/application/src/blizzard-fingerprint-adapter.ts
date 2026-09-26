import type {
  BlizzardGateway,
  BlizzardProfileRequestObserver
} from "@slashwho/blizzard";
import type { FingerprintGateway } from "@slashwho/domain";

function capReached(): Error {
  return Object.assign(new Error("fingerprint_cap_reached"), {
    kind: "fingerprint_cap_reached"
  });
}

export function createBlizzardFingerprintAdapter(
  gateway: BlizzardGateway,
  options: {
    requestCap: number;
    recordRequest: () => Promise<void>;
    onRateLimited?: () => Promise<void> | void;
  }
): FingerprintGateway {
  // Counted when a request is reserved, not when its write lands, so reads in
  // flight together can never reserve more than the cap between them.
  let requestsReserved = 0;

  function reserve(): void {
    if (requestsReserved >= options.requestCap) throw capReached();
    requestsReserved += 1;
  }

  async function recordProfileRequest(): Promise<void> {
    reserve();
    await options.recordRequest();
  }

  /**
   * Reserves the first of a call's requests when the call is made rather than
   * when the client gets round to it. Concurrent candidate reads are made in
   * candidate order, so a cap reached mid-window refuses one candidate and
   * every one after it, never an earlier one: the sweep's resume cursor
   * depends on that. Any further request in the same call reserves as usual.
   */
  function prepaidObserver(): BlizzardProfileRequestObserver {
    reserve();
    let prepaid = true;
    return async () => {
      if (prepaid) {
        prepaid = false;
        await options.recordRequest();
        return;
      }
      await recordProfileRequest();
    };
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
        await options.onRateLimited?.();
      }
      throw error;
    }
  }

  return {
    getGuildRoster: (root, signal) =>
      request(() => gateway.getGuildRoster(root, signal, recordProfileRequest)),
    getGuildRosterByIdentity: (guild, signal) =>
      request(() =>
        gateway.getGuildRosterByIdentity(guild, signal, recordProfileRequest)
      ),
    getAchievementFingerprint: (key, signal) => {
      let observer: BlizzardProfileRequestObserver;
      try {
        observer = prepaidObserver();
      } catch (error) {
        return Promise.reject(error);
      }
      return request(() =>
        gateway.getAchievementFingerprint(key, signal, observer)
      );
    }
  };
}
