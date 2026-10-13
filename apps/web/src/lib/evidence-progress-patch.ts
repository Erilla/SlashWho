import type {
  ApplicantDossier,
  EvidenceRunProgressResponse
} from "@slashwho/contracts";
import { canonicalCharacterId } from "@slashwho/domain";

/** Patch collection courtesy fields only; published evidence stays authoritative. */
export function patchEvidenceProgress(
  dossier: ApplicantDossier,
  runs: EvidenceRunProgressResponse["runs"],
  hasMissingRuns = false
): ApplicantDossier {
  let changed = false;
  const characters = dossier.characters.map((character) => {
    if (character.excluded) return character;
    const identities = [
      character.key,
      ...(character.warcraftLogsAliases ?? [])
    ];
    const active = identities.flatMap((key) =>
      runs.filter(
        (run) =>
          run.state !== "settled" &&
          canonicalCharacterId(run.key) === canonicalCharacterId(key)
      )
    );
    const selected = active[0];
    if (!selected) return character;

    const evidenceState =
      identities.length > 1
        ? character.evidenceState === "waiting" &&
          !hasMissingRuns &&
          active.every((run) => run.state === "running")
          ? "scanning"
          : character.evidenceState
        : character.evidenceState === "complete" ||
            character.evidenceState === "partial"
          ? character.evidenceState
          : selected.evidenceState;
    // Dossier rows require a non-empty phase list when present. An empty
    // initialised ledger cannot erase progress the authoritative read showed.
    const collectionProgress = selected.collectionProgress.length
      ? selected.collectionProgress
      : character.collectionProgress;
    if (
      character.evidenceState === evidenceState &&
      character.researchState === "gathering" &&
      JSON.stringify(character.collectionProgress) ===
        JSON.stringify(collectionProgress)
    )
      return character;
    changed = true;
    return {
      ...character,
      ...(evidenceState === undefined ? {} : { evidenceState }),
      ...(collectionProgress === undefined ? {} : { collectionProgress }),
      researchState: "gathering" as const
    };
  });
  return changed ? { ...dossier, characters } : dossier;
}
