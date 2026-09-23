import type { DiscoveryQueue, Repositories } from "@slashwho/database";
import type { CharacterKey, RaiderIoGateway } from "@slashwho/domain";
import { fullEvidencePhasePlan } from "./evidence-phase-ledger";

/** The fixed cutoff makes replay of one source intent idempotent after a crash. */
export async function startApplicantCollection(input: {
  key: CharacterKey;
  observedAt: Date;
  discoveryFreshnessHours: number;
  evidenceFreshnessHours: number;
  repositories: Pick<
    Repositories,
    "searchReservations" | "suppressions" | "evidence"
  >;
  queue: Pick<DiscoveryQueue, "enqueue" | "enqueueCharacterEvidence">;
  raiderio: Pick<RaiderIoGateway, "getCharacter">;
}): Promise<"started" | "reused" | "suppressed" | "unavailable"> {
  const { key, repositories, queue } = input;
  if (await repositories.suppressions.isActive(key, new Date()))
    return "suppressed";
  const discovery = await repositories.searchReservations.reserve({
    key,
    callerClass: "bot",
    callerBucketHash: "applicant-sheet",
    limit: 1_000_000,
    at: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    freshnessCutoff: new Date(
      input.observedAt.getTime() - input.discoveryFreshnessHours * 60 * 60_000
    )
  });
  if (discovery.kind === "suppressed") return "suppressed";
  if (discovery.kind === "rate_limited" || discovery.kind === "negative")
    return "unavailable";
  if (discovery.kind === "reserved") {
    let rootCharacter;
    try {
      rootCharacter = await input.raiderio.getCharacter(key);
    } catch {
      await repositories.searchReservations.cancel(discovery.run.id);
      return "unavailable";
    }
    try {
      const queueJobId = await queue.enqueue({
        runId: discovery.run.id,
        key,
        rootCharacter,
        enqueuedAt: new Date().toISOString()
      });
      await repositories.searchReservations.markEnqueued(
        discovery.run.id,
        queueJobId
      );
    } catch {
      // Pending search recovery can dispatch this reservation after a queue failure.
      return "unavailable";
    }
  }
  if (
    discovery.kind === "active" &&
    discovery.run.status === "queued" &&
    discovery.run.queueJobId === null
  ) {
    const queueJobId = await queue.enqueue({
      runId: discovery.run.id,
      key,
      enqueuedAt: new Date().toISOString()
    });
    await repositories.searchReservations.markEnqueued(
      discovery.run.id,
      queueJobId
    );
  }
  // Recheck at the last budget-bearing boundary. An intent suppressed here is
  // settled by the caller and never awakened by suppression expiry.
  if (await repositories.suppressions.isActive(key, new Date()))
    return "suppressed";
  const evidence = await repositories.evidence.reserve({
    key,
    at: new Date(),
    freshnessCutoff: new Date(
      input.observedAt.getTime() - input.evidenceFreshnessHours * 60 * 60_000
    ),
    phasePlan: fullEvidencePhasePlan()
  });
  if (evidence.kind === "reserved") {
    const queueJobId = await queue.enqueueCharacterEvidence(evidence.run.id, {
      enqueuedAt: new Date().toISOString(),
      mode: "full"
    });
    await repositories.evidence.markEnqueued(evidence.run.id, queueJobId);
  }
  if (
    evidence.kind === "active" &&
    evidence.run.status === "queued" &&
    evidence.run.queueJobId === null
  ) {
    const queueJobId = await queue.enqueueCharacterEvidence(evidence.run.id, {
      enqueuedAt: new Date().toISOString(),
      mode: "full"
    });
    await repositories.evidence.markEnqueued(evidence.run.id, queueJobId);
  }
  return discovery.kind === "reserved" || evidence.kind === "reserved"
    ? "started"
    : "reused";
}
