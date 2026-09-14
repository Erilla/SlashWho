import type { ApplicantDossier } from "@slashwho/contracts";

type DossierRaidListProps = Readonly<{
  raids: ApplicantDossier["raids"];
}>;

function displayGuild(
  guild: ApplicantDossier["raids"][number]["bosses"][number]["firstKill"]["guild"]
) {
  return guild ? `${guild.name} · ${guild.realm}` : "—";
}

function compareFirstKillsLatestFirst(
  a: ApplicantDossier["raids"][number]["bosses"][number]["firstKill"],
  b: ApplicantDossier["raids"][number]["bosses"][number]["firstKill"]
): number {
  return (
    b.killedAt.localeCompare(a.killedAt) ||
    (a.reportUrl ?? "").localeCompare(b.reportUrl ?? "") ||
    (a.guild?.name ?? "").localeCompare(b.guild?.name ?? "") ||
    (a.guild?.realm ?? "").localeCompare(b.guild?.realm ?? "") ||
    (a.historicWorldRank ?? -1) - (b.historicWorldRank ?? -1) ||
    a.characters.join("\0").localeCompare(b.characters.join("\0"))
  );
}

export function DossierRaidList({ raids }: DossierRaidListProps) {
  return (
    <section aria-labelledby="historic-mythic-evidence-heading">
      <h2 className="section-heading" id="historic-mythic-evidence-heading">
        Historic Mythic boss evidence
      </h2>
      {raids.length === 0 ? (
        <p className="empty-state">
          No public historic Mythic evidence was found.
        </p>
      ) : (
        <div className="dossier-raid-list">
          {raids.map((raid) => (
            <section className="dossier-raid" key={raid.raidId}>
              <h3 className="dossier-raid-heading">
                {raid.imageUrl ? (
                  <img
                    alt={`${raid.raidName} artwork`}
                    className="dossier-raid-artwork"
                    loading="lazy"
                    src={raid.imageUrl}
                  />
                ) : null}
                <span>{raid.raidName}</span>
              </h3>
              <div className="dossier-boss-list">
                {raid.bosses.map((boss) => {
                  const firstKills = [
                    ...(boss.firstKills ?? [boss.firstKill])
                  ].sort(compareFirstKillsLatestFirst);
                  const firstKill = firstKills[0]!;
                  return (
                    <article
                      className="dossier-boss"
                      key={boss.bossId}
                      role="group"
                      aria-label={`${boss.bossName} evidence`}
                    >
                      <div className="dossier-boss-heading">
                        {boss.imageUrl ? (
                          <img
                            alt={`${boss.bossName} artwork`}
                            className="dossier-boss-artwork"
                            loading="lazy"
                            src={boss.imageUrl}
                          />
                        ) : null}
                        <div>
                          <h4>{boss.bossName}</h4>
                          <p className="dossier-boss-rank">
                            {firstKill.historicWorldRank === null
                              ? "World rank: —"
                              : `World #${firstKill.historicWorldRank}`}
                          </p>
                        </div>
                      </div>
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
