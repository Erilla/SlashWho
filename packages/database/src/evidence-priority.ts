import type { EvidenceRunOrigin } from "@slashwho/contracts";

const evidencePriorities = {
  dossier_initial: 30,
  applicant_sheet: 30,
  dossier_read: 20,
  fingerprint_admission: 20,
  tier_search: 20,
  discovery: 10,
  resume_sweep: 10,
  refresh: 0,
  rebuild: 0,
  historic_alias: 0,
  unknown: 0
} satisfies Record<EvidenceRunOrigin, number>;

export function evidenceRunPriority(origin: EvidenceRunOrigin): number {
  return evidencePriorities[origin];
}
