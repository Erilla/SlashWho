import type { DossierLimitation } from "@slashwho/contracts";

import { DossierCharacterName } from "./dossier-character-name";
import { CharacterProfileLinks } from "./profile-links";
import { DossierRateLimitCountdown } from "./dossier-rate-limit-countdown";

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
            {limitation.retryAt ? (
              <DossierRateLimitCountdown
                retryAt={limitation.retryAt}
                source={limitation.source}
              />
            ) : null}
            {limitation.character ? (
              <>
                {" Affected character: "}
                <DossierCharacterName character={limitation.character} />.
                <CharacterProfileLinks
                  character={{
                    key: limitation.character,
                    displayName: limitation.character.name
                  }}
                />
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
