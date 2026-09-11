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
  const cuttingEdgeRaids = raids.filter((raid) => raid.cuttingEdge === true);

  return (
    <section aria-labelledby="historic-cutting-edge-heading">
      <h2 className="section-heading" id="historic-cutting-edge-heading">
        Historic Cutting Edge
      </h2>
      {cuttingEdgeRaids.length === 0 ? (
        <p className="empty-state">No historic Cutting Edge evidence was found.</p>
      ) : (
        <div className="dossier-raid-list">
          {cuttingEdgeRaids.map((raid) => (
            <section className="dossier-raid" key={raid.raidId}>
              <h3>{raid.raidName}</h3>
              <div className="dossier-boss-list">
                {raid.bosses.map((boss) => (
                  <article
                    className="dossier-boss"
                    key={boss.bossId}
                    role="group"
                    aria-label={`${boss.bossName} evidence`}
                  >
                    <h4>{boss.bossName}</h4>
                    <p className="dossier-boss-rank">
                      {boss.firstKill.historicWorldRank === null
                        ? "World rank: —"
                        : `World #${boss.firstKill.historicWorldRank}`}
                    </p>
                    <details>
                      <summary>View first-kill evidence</summary>
                      <dl className="dossier-evidence">
                        <div>
                          <dt>First kill</dt>
                          <dd>
                            <time dateTime={boss.firstKill.killedAt}>
                              {new Intl.DateTimeFormat("en-GB", {
                                dateStyle: "medium",
                                timeZone: "UTC"
                              }).format(new Date(boss.firstKill.killedAt))}
                            </time>
                          </dd>
                        </div>
                        <div>
                          <dt>Guild</dt>
                          <dd>Guild: {displayGuild(boss.firstKill.guild)}</dd>
                        </div>
                        <div>
                          <dt>World rank</dt>
                          <dd>
                            World rank: {boss.firstKill.historicWorldRank ?? "—"}
                          </dd>
                        </div>
                        <div>
                          <dt>Report</dt>
                          <dd>
                            {boss.firstKill.reportUrl ? (
                              <a
                                className="external-link"
                                href={boss.firstKill.reportUrl}
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
                          <dd>{boss.firstKill.characters.join(", ") || "—"}</dd>
                        </div>
                      </dl>
                    </details>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
