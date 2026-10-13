import type { CharacterKey } from "@slashwho/domain";
import { fullEvidencePhasePlan } from "@slashwho/application";
import {
  evidenceRunPriority,
  type DiscoveryQueue,
  type EvidenceRepository
} from "@slashwho/database";

/** Reuses a fresh complete publication, otherwise queues full fingerprint evidence. */
export async function enqueueFingerprintAdmissionEvidence(input: {
  key: CharacterKey;
  root: CharacterKey;
  at: Date;
  freshnessMs: number;
  evidence: Pick<EvidenceRepository, "reserve" | "markEnqueued">;
  queue: Pick<
    DiscoveryQueue,
    "enqueueCharacterEvidence" | "promoteCharacterEvidence"
  >;
}): Promise<void> {
  const { key, root, at, freshnessMs, evidence, queue } = input;
  const reserve = (freshnessCutoff: Date) =>
    evidence.reserve({
      key,
      origin: "fingerprint_admission",
      root,
      freshnessCutoff,
      at,
      phasePlan: fullEvidencePhasePlan()
    });

  let reservation = await reserve(new Date(at.getTime() - freshnessMs));
  if (
    reservation.kind === "fresh" &&
    (reservation.completed.run.mode !== "full" ||
      reservation.completed.run.status !== "complete" ||
      reservation.completed.run.lightRefresh === true)
  ) {
    reservation = await reserve(at);
  }

  if (reservation.kind !== "reserved") {
    const active =
      reservation.kind === "fresh" ? reservation.active : reservation.run;
    if (active?.queueJobId) {
      await queue.promoteCharacterEvidence(
        active.queueJobId,
        evidenceRunPriority("fingerprint_admission")
      );
    } else if (active?.status === "queued" && active.queueJobId === null) {
      const jobId = await queue.enqueueCharacterEvidence(active.id, {
        priority: Math.max(
          evidenceRunPriority(active.origin ?? "fingerprint_admission"),
          evidenceRunPriority("fingerprint_admission")
        ),
        enqueuedAt: at.toISOString(),
        mode: active.lightRefresh ? "light" : "full"
      });
      await evidence.markEnqueued(active.id, jobId);
    }
    return;
  }

  const queueJobId = await queue.enqueueCharacterEvidence(reservation.run.id, {
    enqueuedAt: at.toISOString(),
    mode: "full",
    priority: evidenceRunPriority(
      reservation.run.origin ?? "fingerprint_admission"
    )
  });
  await evidence.markEnqueued(reservation.run.id, queueJobId);
}
