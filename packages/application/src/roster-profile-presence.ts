import type {
  RaiderIoLoggedEncounterInput,
  RosterProfileResolutionRepository
} from "@slashwho/database";
import {
  isValidRosterProfileLocator,
  type RaiderIoGateway,
  type RosterProfileLocator,
  type RaiderIoEvidenceLimitation
} from "@slashwho/raiderio";

export const MAX_ROSTER_PROFILE_RESOLUTIONS = 50;
export const ROSTER_PROFILE_RESOLUTION_CONCURRENCY = 4;
const answerTtlMs = 30 * 24 * 60 * 60 * 1000;
type Presence = "present" | "absent" | "unknown";
const locatorKey = (locator: RosterProfileLocator) =>
  `${locator.region}\0${locator.realm}\0${locator.name}\0${locator.historicId}`;

/** A roster locator is never identity proof; only its upstream resolved ID is. */
export async function resolveRosterPresence(input: {
  encounters: readonly RaiderIoLoggedEncounterInput[];
  subjectId: number;
  subjectClass: string;
  repository?: RosterProfileResolutionRepository | undefined;
  resolve?: RaiderIoGateway["resolveRosterProfile"] | undefined;
  signal: AbortSignal;
  now: () => Date;
  onPhysicalRequest?: (() => void) | undefined;
}): Promise<{
  presence: ReadonlyMap<number, Presence>;
  limitation: RaiderIoEvidenceLimitation | null;
}> {
  const presence = new Map<number, Presence>();
  const targets = new Map<number, string[]>();
  const locators = new Map<string, RosterProfileLocator>();
  const invalid = new Set<number>();
  for (const encounter of input.encounters) {
    if (
      encounter.members.some(
        (member) => member.raiderIoCharacterId === input.subjectId
      )
    ) {
      presence.set(encounter.loggedEncounterId, "present");
      continue;
    }
    const keys: string[] = [];
    for (const member of encounter.members) {
      if (member.className !== input.subjectClass || !/-\d+$/.test(member.name))
        continue;
      const locator = {
        region: member.region,
        realm: member.realm,
        name: member.name.toLocaleLowerCase("en-US"),
        historicId: member.raiderIoCharacterId
      };
      if (!isValidRosterProfileLocator(locator)) {
        invalid.add(encounter.loggedEncounterId);
        continue;
      }
      const key = locatorKey(locator);
      keys.push(key);
      locators.set(key, locator);
    }
    targets.set(encounter.loggedEncounterId, keys);
  }
  const answers = new Map<
    string,
    { presence: Presence; code?: RaiderIoEvidenceLimitation }
  >();
  if (locators.size > 0 && input.repository && input.resolve) {
    try {
      const repository = input.repository;
      const resolve = input.resolve;
      const stored = await repository.load([...locators.values()]);
      const held = new Map(stored.map((row) => [locatorKey(row), row]));
      const at = input.now();
      const queue: RosterProfileLocator[] = [];
      for (const [key, locator] of locators) {
        const row = held.get(key);
        if (
          row?.answeredAt &&
          at.getTime() - row.answeredAt.getTime() < answerTtlMs
        ) {
          answers.set(
            key,
            row.resolvedId !== null
              ? {
                  presence:
                    row.resolvedId === input.subjectId ? "present" : "absent"
                }
              : {
                  presence: "unknown",
                  code: (row.limitationCode ??
                    "unavailable") as RaiderIoEvidenceLimitation
                }
          );
        } else if (row?.retryNotBefore && row.retryNotBefore > at) {
          // Cooldowns prohibit another physical read, not reuse of saved proof.
          answers.set(key, { presence: "unknown", code: "rate_limited" });
        } else queue.push(locator);
      }
      queue.sort((a, b) => {
        const aa = held.get(locatorKey(a))?.lastAttemptAt?.getTime();
        const bb = held.get(locatorKey(b))?.lastAttemptAt?.getTime();
        return (
          (aa ?? -Infinity) - (bb ?? -Infinity) ||
          locatorKey(a).localeCompare(locatorKey(b))
        );
      });
      let next = 0;
      let slots = 0;
      let stopped = false;
      const outcomes = await Promise.allSettled(
        Array.from(
          { length: ROSTER_PROFILE_RESOLUTION_CONCURRENCY },
          async () => {
            while (
              !stopped &&
              next < queue.length &&
              slots < MAX_ROSTER_PROFILE_RESOLUTIONS
            ) {
              const locator = queue[next++];
              if (!locator) break;
              const key = locatorKey(locator);
              slots++;
              const token = await repository.reserve(locator, input.now());
              if (token === null) {
                slots--;
                answers.set(key, { presence: "unknown", code: "unavailable" });
                continue;
              }
              if (stopped) {
                answers.set(key, { presence: "unknown", code: "unavailable" });
                continue;
              }
              input.signal.throwIfAborted();
              let result;
              try {
                result = await resolve(
                  locator,
                  input.signal,
                  input.onPhysicalRequest
                );
              } catch (error) {
                if (input.signal.aborted) throw error;
                result = {
                  kind: "limitation" as const,
                  code: "unavailable" as const
                };
              }
              const resolved =
                result.kind === "resolved" &&
                Number.isSafeInteger(result.characterId) &&
                result.characterId > 0;
              const code =
                result.kind === "limitation" ? result.code : "schema_drift";
              if (
                !resolved &&
                (code === "rate_limited" || code === "unavailable")
              )
                stopped = true;
              const answeredAt = input.now();
              const retryAfterMs =
                result.kind === "limitation" ? result.retryAfterMs : undefined;
              const saved = await repository.answer(
                locator,
                token,
                {
                  resolvedId:
                    resolved && result.kind === "resolved"
                      ? result.characterId
                      : null,
                  limitationCode: resolved ? null : code,
                  retryNotBefore:
                    retryAfterMs === undefined
                      ? null
                      : new Date(
                          answeredAt.getTime() + Math.max(0, retryAfterMs)
                        )
                },
                answeredAt
              );
              answers.set(
                key,
                saved && resolved && result.kind === "resolved"
                  ? {
                      presence:
                        result.characterId === input.subjectId
                          ? "present"
                          : "absent"
                    }
                  : { presence: "unknown", code: saved ? code : "unavailable" }
              );
            }
          }
        )
      );
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } catch (error) {
      if (input.signal.aborted) throw error;
      // Persisted answers are the proof. Failed storage must never manufacture presence.
      for (const key of locators.keys())
        answers.set(key, { presence: "unknown", code: "unavailable" });
    }
  }
  if (!input.repository || !input.resolve) {
    for (const key of locators.keys())
      answers.set(key, { presence: "unknown", code: "unavailable" });
  }
  let limitation: RaiderIoEvidenceLimitation | null = null;
  for (const [id, keys] of targets) {
    if (keys.some((key) => answers.get(key)?.presence === "present"))
      presence.set(id, "present");
    else if (
      invalid.has(id) ||
      keys.some((key) => answers.get(key)?.presence !== "absent")
    ) {
      presence.set(id, "unknown");
      limitation ??= invalid.has(id)
        ? "schema_drift"
        : (keys
            .map((key) => answers.get(key)?.code)
            .find((code) => code !== undefined) ?? "request_cap");
    } else presence.set(id, "absent");
  }
  return { presence, limitation };
}
