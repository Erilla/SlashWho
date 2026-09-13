import type { ApplicantDossier } from "@slashwho/contracts";

import { DossierMediaFallback } from "./dossier-media-fallback";

type DossierRaidListProps = Readonly<{
  raids: ApplicantDossier["raids"];
}>;

function ReportLinks({
  evidence
}: {
  evidence: ApplicantDossier["raids"][number]["bosses"][number]["firstKill"];
}) {
  const urls =
    evidence.reportUrls ?? (evidence.reportUrl ? [evidence.reportUrl] : []);
  if (urls.length === 0) return <>Report: —</>;
  return (
    <ul className="dossier-report-links">
      {urls.map((url, index) => (
        <li key={url}>
          <a className="external-link" href={url}>
            {urls.length === 1
              ? "View Warcraft Logs report"
              : `View Warcraft Logs report ${index + 1}`}
          </a>
        </li>
      ))}
    </ul>
  );
}

function displayGuild(
  guild: ApplicantDossier["raids"][number]["bosses"][number]["firstKill"]["guild"]
) {
  return guild ? `${guild.name} · ${guild.realm}` : "—";
}

function displayDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeZone: "UTC"
  }).format(new Date(isoDate));
}

export function DossierRaidList({ raids }: DossierRaidListProps) {
  return (
    <section
      aria-labelledby="historic-mythic-evidence-heading"
      className="dossier-panel dossier-mythic-evidence-panel"
    >
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
                ) : (
                  <DossierMediaFallback
                    alt={`${raid.raidName} artwork`}
                    className="dossier-raid-artwork"
                  />
                )}
                <span>{raid.raidName}</span>
              </h3>
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
                      <div className="dossier-boss-heading">
                        {boss.imageUrl ? (
                          <img
                            alt={`${boss.bossName} artwork`}
                            className="dossier-boss-artwork"
                            loading="lazy"
                            src={boss.imageUrl}
                          />
                        ) : (
                          <DossierMediaFallback
                            alt={`${boss.bossName} artwork`}
                            className="dossier-boss-artwork"
                          />
                        )}
                        <div>
                          <h4 className="dossier-boss-title">
                            <svg
                              aria-label="Verified Mythic kill"
                              className="dossier-kill-icon"
                              role="img"
                              viewBox="0 0 20 20"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <title>Verified Mythic kill</title>
                              <circle cx="10" cy="10" r="8" />
                              <path d="m6 10 3 3 5-6" />
                            </svg>
                            <span>{boss.bossName}</span>
                          </h4>
                          <p className="dossier-boss-first-kill">
                            First kill: {displayDate(firstKill.killedAt)} ·{" "}
                            {firstKill.characters.join(", ") || "—"}
                          </p>
                          <p className="dossier-boss-rank">
                            {firstKill.historicWorldRank === null
                              ? "World rank: —"
                              : `World #${firstKill.historicWorldRank}`}
                          </p>
                        </div>
                      </div>
                      <details>
                        <summary>View kill evidence</summary>
                        <section
                          aria-label="Kill evidence"
                          className="dossier-evidence-list"
                        >
                          {firstKills.map((evidence, index) => (
                            <dl
                              className="dossier-evidence"
                              key={`${evidence.killedAt}-${evidence.reportUrl ?? index}`}
                            >
                              <div>
                                <dt>{index === 0 ? "First kill" : "Kill"}</dt>
                                <dd>
                                  <time dateTime={evidence.killedAt}>
                                    {displayDate(evidence.killedAt)}
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
                                  World rank:{" "}
                                  {evidence.historicWorldRank ?? "—"}
                                </dd>
                              </div>
                              <div>
                                <dt>Reports</dt>
                                <dd>
                                  <ReportLinks evidence={evidence} />
                                </dd>
                              </div>
                              <div>
                                <dt>Characters present</dt>
                                <dd>{evidence.characters.join(", ") || "—"}</dd>
                              </div>
                            </dl>
                          ))}
                        </section>
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
