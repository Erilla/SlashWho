import type { DossierLimitation } from "@slashwho/contracts";

type DossierLimitationsProps = Readonly<{
  limitations: readonly DossierLimitation[];
}>;

export function DossierLimitations({ limitations }: DossierLimitationsProps) {
  if (limitations.length === 0) return null;

  return (
    <section
      className="dossier-panel dossier-limitations"
      aria-labelledby="limitations-heading"
    >
      <h2 className="section-heading" id="limitations-heading">
        Data limitations
      </h2>
      <ul>
        {limitations.map((limitation, index) => (
          <li key={`${limitation.source}-${limitation.code}-${index}`}>
            {limitation.message}
            {limitation.character
              ? ` Affected character: ${limitation.character.name}.`
              : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
