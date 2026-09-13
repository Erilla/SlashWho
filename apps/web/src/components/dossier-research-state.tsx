import type { DossierResearch } from "@slashwho/contracts";

type DossierResearchStateProps = Readonly<{
  research: DossierResearch;
}>;

export function DossierResearchState({ research }: DossierResearchStateProps) {
  return (
    <p className="dossier-status" aria-live="polite" role="status">
      {research.state === "initial" ? (
        <svg
          aria-hidden="true"
          className="dossier-loading-spinner"
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="12" r="8" />
        </svg>
      ) : null}
      <span>{research.message}</span>
    </p>
  );
}
