import {
  collectionPhaseSchema,
  type CollectionPhase,
  type DossierLimitationCode
} from "@slashwho/contracts";
import type { EvidenceRunPhase } from "@slashwho/database";

export function contractLimitationCode(code: string): DossierLimitationCode {
  return code === "schema_drift"
    ? "schema_changed"
    : (code as DossierLimitationCode);
}

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
      : undefined;
    const withCode = collectionPhaseSchema.safeParse({
      id: phase.id,
      state: phase.state,
      ...(limitationCode ? { limitationCode } : {})
    });
    if (withCode.success) return [withCode.data];
    const withoutCode = collectionPhaseSchema.safeParse({
      id: phase.id,
      state: phase.state
    });
    return withoutCode.success ? [withoutCode.data] : [];
  });
}
