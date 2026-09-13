import type { ApplicantDossier } from "@slashwho/contracts";

import { DossierMediaFallback } from "./dossier-media-fallback";

type DossierCuttingEdgeListProps = Readonly<{
  cuttingEdges: ApplicantDossier["cuttingEdges"];
}>;

export function DossierCuttingEdgeList({
  cuttingEdges
}: DossierCuttingEdgeListProps) {
  return (
    <section
      aria-labelledby="historic-cutting-edge-heading"
      className="dossier-panel dossier-cutting-edge-panel"
    >
      <h2 className="section-heading" id="historic-cutting-edge-heading">
        Historic Cutting Edge
      </h2>
      <p className="empty-state">
        New achievements may take up to 15 minutes to appear.
      </p>
      {cuttingEdges.length === 0 ? (
        <p className="empty-state">
          No public Cutting Edge achievements were found.
        </p>
      ) : (
        <ul className="dossier-cutting-edge-list">
          {cuttingEdges.map((achievement) => (
            <li
              className="dossier-achievement-card"
              key={achievement.achievementId}
            >
              {achievement.iconUrl ? (
                <img
                  alt={`${achievement.achievementName} icon`}
                  className="dossier-achievement-icon"
                  loading="lazy"
                  src={achievement.iconUrl}
                />
              ) : (
                <DossierMediaFallback
                  alt={`${achievement.achievementName} icon`}
                  className="dossier-achievement-icon"
                />
              )}
              <div>
                <h3>{achievement.achievementName}</h3>
                <p>{achievement.description}</p>
                <p>
                  Achieved:{" "}
                  <time dateTime={achievement.completedAt}>
                    {new Intl.DateTimeFormat("en-GB", {
                      dateStyle: "medium",
                      timeZone: "UTC"
                    }).format(new Date(achievement.completedAt))}
                  </time>
                </p>
                <p>{achievement.characters.join(", ")}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
