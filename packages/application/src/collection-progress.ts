import {
  collectionPhaseSchema,
  type CollectionPhase
} from "@slashwho/contracts";
import type { EvidenceRunPhase } from "@slashwho/database";

import { contractLimitationCode } from "./dossier-limitations";

/**
 * The ledger as the dossier contract speaks it. A step or code the contract
 * does not yet name is dropped rather than failing the whole read: progress is
 * a courtesy to the reader, and the evidence beside it must still render.
 */
export function collectionProgress(
  phases: readonly Pick<EvidenceRunPhase, "id" | "state" | "limitationCode">[]
): CollectionPhase[] {
  return phases.flatMap((phase) => {
    const limitationCode = phase.limitationCode
      ? contractLimitationCode(phase.limitationCode)
      : null;
    const parsed = collectionPhaseSchema.safeParse({
      id: phase.id,
      state: phase.state,
      ...(limitationCode ? { limitationCode } : {})
    });
    return parsed.success ? [parsed.data] : [];
  });
}
