import type { ApplicantDossier } from "@slashwho/contracts";

type DossierRaidListProps = Readonly<{
  raids: ApplicantDossier["raids"];
}>;

function displayGuild(
  guild: ApplicantDossier["raids"][number]["bosses"][number]["firstKill"]["guild"]
) {
  return guild ? `${guild.name} · ${guild.realm}` : "—";
}

export function DossierRaidList({ raids }: DossierRaidListProps) {
  return (
    <section aria-labelledby="historic-cutting-edge-heading">
      <h2 className="section-heading" id="historic-cutting-edge-heading">
        Historic Cutting Edge
      </h2>
      {raids.length === 0 ? (
        <p className="empty-state">
          No public historic Mythic evidence was found.
        </p>
      ) : (
        <div className="dossier-raid-list">
          {raids.map((raid) => (
            <section className="dossier-raid" key={raid.raidId}>
              <h3>{raid.raidName}</h3>
              <p className="dossier-raid-status">
                {raid.cuttingEdge
                  ? "Final-boss evidence found"
                  : "Final-boss status is unknown from public report evidence."}
              </p>
              <div className="dossier-boss-list">
                {raid.bosses.map((boss) => {
                  const firstKills = boss.firstKills ?? [boss.firstKill];
                  const firstKill = firstKills[0]!;
                  return (
                    <article
                      className="dossier-boss"
                      key={boss.bossId}
                      role="group"
                      aria-label={`${boss.bossName} evidence`}
                    >
                      <h4>{boss.bossName}</h4>
                      <p className="dossier-boss-rank">
                        {firstKill.historicWorldRank === null
                          ? "World rank: —"
                          : `World #${firstKill.historicWorldRank}`}
                      </p>
                      <details>
                        <summary>View first-kill evidence</summary>
                        {firstKills.map((evidence, index) => (
                          <dl
                            className="dossier-evidence"
                            key={`${evidence.killedAt}-${evidence.reportUrl ?? index}`}
                          >
                            <div>
                              <dt>First kill</dt>
                              <dd>
                                <time dateTime={evidence.killedAt}>
                                  {new Intl.DateTimeFormat("en-GB", {
                                    dateStyle: "medium",
                                    timeZone: "UTC"
                                  }).format(new Date(evidence.killedAt))}
                                </time>
                              </dd>
                            </div>
                            <div>
                              <dt>Guild</dt>
                              <dd>Guild: {displayGuild(evidence.guild)}</dd>
                            </div>
                            <div>
                              <dt>World rank</dt>
                              <dd>
                                World rank: {evidence.historicWorldRank ?? "—"}
                              </dd>
                            </div>
                            <div>
                              <dt>Report</dt>
                              <dd>
                                {evidence.reportUrl ? (
                                  <a
                                    className="external-link"
                                    href={evidence.reportUrl}
                                  >
                                    View Warcraft Logs report
                                  </a>
                                ) : (
                                  "Report: —"
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt>Characters present</dt>
                              <dd>{evidence.characters.join(", ") || "—"}</dd>
                            </div>
                          </dl>
                        ))}
                      </details>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
