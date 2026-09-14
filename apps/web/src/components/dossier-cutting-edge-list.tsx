import type { ApplicantDossier } from "@slashwho/contracts";
import { buildBoundedCuttingEdgeSequence } from "@slashwho/domain";

import { DossierCharacterNames } from "./dossier-character-name";
import { DossierMediaFallback } from "./dossier-media-fallback";

type DossierCuttingEdgeListProps = Readonly<{
  cuttingEdges: ApplicantDossier["cuttingEdges"];
  limitations: ApplicantDossier["limitations"];
}>;

export function DossierCuttingEdgeList({
  cuttingEdges,
  limitations
}: DossierCuttingEdgeListProps) {
  const sequence = limitations.some(
    (limitation) => limitation.source === "blizzard"
  )
    ? cuttingEdges.map((achievement) => ({
        status: "recorded" as const,
        achievement
      }))
    : buildBoundedCuttingEdgeSequence(cuttingEdges);

  return (
    <section
      aria-labelledby="historic-cutting-edge-heading"
      className="dossier-panel dossier-cutting-edge-panel"
    >
      <div className="dossier-cutting-edge-heading">
        <h2 className="section-heading" id="historic-cutting-edge-heading">
          Historic Cutting Edge
        </h2>
        <span
          aria-label={`${cuttingEdges.length} Cutting Edge ${cuttingEdges.length === 1 ? "achievement" : "achievements"}`}
          className="dossier-cutting-edge-count"
          role="img"
        >
          {cuttingEdges.length}
        </span>
      </div>
      <p className="empty-state">
        New achievements may take up to 15 minutes to appear.
      </p>
      {cuttingEdges.length === 0 ? (
        <p className="empty-state">
          No public Cutting Edge achievements were found.
        </p>
      ) : (
        <ul className="dossier-cutting-edge-list">
          {sequence.map((entry) => (
            <li
              className={`dossier-achievement-card${entry.status === "not_recorded" ? " dossier-achievement-card--not-recorded" : ""}`}
              key={
                entry.status === "recorded"
                  ? `${entry.achievement.achievementId}-${entry.achievement.completedAt}`
                  : `${entry.achievement.achievementId}-not-recorded`
              }
            >
              {entry.achievement.iconUrl ? (
                <img
                  alt={`${entry.achievement.achievementName} icon`}
                  className="dossier-achievement-icon"
                  loading="lazy"
                  src={entry.achievement.iconUrl}
                />
              ) : (
                <DossierMediaFallback
                  alt={`${entry.achievement.achievementName} icon`}
                  className="dossier-achievement-icon"
                />
              )}
              <div>
                <h3>{entry.achievement.achievementName}</h3>
                <p>{entry.achievement.description}</p>
                {entry.status === "not_recorded" ? (
                  <p className="dossier-achievement-status">Not recorded</p>
                ) : (
                  <>
                    <p>
                      Achieved:{" "}
                      <time dateTime={entry.achievement.completedAt}>
                        {new Intl.DateTimeFormat("en-GB", {
                          dateStyle: "medium",
                          timeZone: "UTC"
                        }).format(new Date(entry.achievement.completedAt))}
                      </time>
                    </p>
                    <p>
                      <DossierCharacterNames
                        characters={entry.achievement.characters}
                      />
                    </p>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
