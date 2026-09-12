import type { DossierResearch } from "@slashwho/contracts";

type DossierResearchStateProps = Readonly<{
  research: DossierResearch;
}>;

export function DossierResearchState({ research }: DossierResearchStateProps) {
  return (
    <p className="dossier-status" aria-live="polite">
      {research.message}
    </p>
  );
}
