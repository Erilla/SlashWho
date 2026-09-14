import type { ApplicantDossier } from "@slashwho/contracts";
import { buildBoundedCuttingEdgeSequence } from "@slashwho/domain";

type DossierCuttingEdgeListProps = Readonly<{
  cuttingEdges: ApplicantDossier["cuttingEdges"];
  limitations: ApplicantDossier["limitations"];
}>;

export function DossierCuttingEdgeList({
  cuttingEdges,
  limitations
}: DossierCuttingEdgeListProps) {
  const orderedCuttingEdges = [...cuttingEdges].sort(
    (a, b) =>
      (a.completedAt < b.completedAt
        ? 1
        : a.completedAt > b.completedAt
          ? -1
          : 0) ||
      (a.achievementId < b.achievementId
        ? -1
        : a.achievementId > b.achievementId
          ? 1
          : 0)
  );
  const sequence = limitations.some(
    (limitation) => limitation.source === "blizzard"
  )
    ? orderedCuttingEdges.map((achievement) => ({
        status: "recorded" as const,
        achievement
      }))
    : buildBoundedCuttingEdgeSequence(orderedCuttingEdges);

  return (
    <section aria-labelledby="historic-cutting-edge-heading">
      <div>
        <h2 className="section-heading" id="historic-cutting-edge-heading">
          Historic Cutting Edge
        </h2>
        <span
          aria-label={`${cuttingEdges.length} Cutting Edge ${cuttingEdges.length === 1 ? "achievement" : "achievements"}`}
          role="img"
        >
          {cuttingEdges.length}
        </span>
      </div>
      {cuttingEdges.length === 0 ? (
        <p className="empty-state">
          No public Cutting Edge achievements were found.
        </p>
      ) : (
        <ul className="dossier-raid-list">
          {sequence.map((entry) => (
            <li
              className="dossier-raid"
              key={
                entry.status === "recorded"
                  ? `${entry.achievement.achievementId}-${entry.achievement.completedAt}`
                  : `${entry.achievement.achievementId}-not-recorded`
              }
            >
              <h3>{entry.achievement.achievementName}</h3>
              <p>{entry.achievement.description}</p>
              {entry.status === "not_recorded" ? (
                <p>Not recorded</p>
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
                  <p>{entry.achievement.characters.join(", ")}</p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
