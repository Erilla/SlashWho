import type { ApplicantDossier } from "@slashwho/contracts";

type DossierCuttingEdgeListProps = Readonly<{
  cuttingEdges: ApplicantDossier["cuttingEdges"];
}>;

export function DossierCuttingEdgeList({
  cuttingEdges
}: DossierCuttingEdgeListProps) {
  return (
    <section aria-labelledby="historic-cutting-edge-heading">
      <h2 className="section-heading" id="historic-cutting-edge-heading">
        Historic Cutting Edge
      </h2>
      {cuttingEdges.length === 0 ? (
        <p className="empty-state">
          No public Cutting Edge achievements were found.
        </p>
      ) : (
        <ul className="dossier-raid-list">
          {cuttingEdges.map((achievement) => (
            <li
              className="dossier-raid"
              key={`${achievement.achievementId}-${achievement.completedAt}`}
            >
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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
