import type { ApplicantDossier } from "@slashwho/contracts";

import { DossierCharacterNames } from "./dossier-character-name";
import { DossierMediaFallback } from "./dossier-media-fallback";
import { UpstreamIconLink } from "./upstream-icon-link";
import { GuildProfileLinks } from "./profile-links";

type Raid = ApplicantDossier["raids"][number];
type Boss = Raid["bosses"][number];
type KillBoss = Extract<Boss, { state: "kill" }>;

type DossierRaidListProps = Readonly<{
  raids: ApplicantDossier["raids"];
}>;

function ReportLinks({ evidence }: { evidence: KillBoss["firstKill"] }) {
  const urls =
    evidence.reportUrls ?? (evidence.reportUrl ? [evidence.reportUrl] : []);
  if (urls.length === 0) return <>Report: —</>;
  return (
    <ul className="dossier-report-links">
      {urls.map((url, index) => (
        <li key={url}>
          <UpstreamIconLink
            href={url}
            label={
              urls.length === 1
                ? "View Warcraft Logs report"
                : `View Warcraft Logs report ${index + 1}`
            }
            source="warcraft_logs"
          />
        </li>
      ))}
    </ul>
  );
}

function displayGuild(guild: KillBoss["firstKill"]["guild"]) {
  return guild ? `${guild.name} · ${guild.realm}` : "—";
}

function displayDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeZone: "UTC"
  }).format(new Date(isoDate));
}

function StatusIcon({ state }: { state: "kill" | "wipe" | "no_logs" }) {
  const label =
    state === "kill"
      ? "Verified Mythic kill"
      : state === "wipe"
        ? "Mythic wipe found"
        : "No qualifying public logs found";
  return (
    <svg
      aria-label={label}
      className={`dossier-evidence-icon dossier-evidence-icon--${state}`}
      role="img"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <title>{label}</title>
      {state === "kill" ? (
        <>
          <circle cx="10" cy="10" r="8" />
          <path d="m6 10 3 3 5-6" />
        </>
      ) : state === "wipe" ? (
        <>
          <circle cx="10" cy="10" r="8" />
          <path d="M7 5v10M7 6h6l-1.5 2L13 10H7" />
        </>
      ) : (
        <>
          <circle cx="9" cy="9" r="5" />
          <path d="m13 13 4 4M4 16 16 4" />
        </>
      )}
    </svg>
  );
}

function BossArtwork({ boss }: { boss: Boss }) {
  return boss.imageUrl ? (
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
  );
}

function KillEvidence({ boss }: { boss: KillBoss }) {
  const firstKills = boss.firstKills ?? [boss.firstKill];
  const firstKill = firstKills[0]!;
  return (
    <>
      <div className="dossier-boss-heading">
        <BossArtwork boss={boss} />
        <div>
          <h4 className="dossier-boss-title">
            <StatusIcon state="kill" />
            <span>{boss.bossName}</span>
          </h4>
          <p className="dossier-boss-first-kill">
            First kill: {displayDate(firstKill.killedAt)} ·{" "}
            <DossierCharacterNames characters={firstKill.characters} />
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
        <section aria-label="Kill evidence" className="dossier-evidence-list">
          {firstKills.map((evidence, index) => (
            <dl
              className={`dossier-evidence${
                index === 0 ? " dossier-evidence-first-kill" : ""
              }`}
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
                <dd>
                  Guild: {displayGuild(evidence.guild)}
                  {evidence.guild ? (
                    <GuildProfileLinks guild={evidence.guild} />
                  ) : null}
                </dd>
              </div>
              <div>
                <dt>World rank</dt>
                <dd>World rank: {evidence.historicWorldRank ?? "—"}</dd>
              </div>
              <div>
                <dt>Reports</dt>
                <dd>
                  <ReportLinks evidence={evidence} />
                </dd>
              </div>
              <div>
                <dt>Characters present</dt>
                <dd>
                  <DossierCharacterNames characters={evidence.characters} />
                </dd>
              </div>
            </dl>
          ))}
        </section>
      </details>
    </>
  );
}

function BossEvidence({ boss }: { boss: Boss }) {
  switch (boss.state) {
    case "kill":
      return <KillEvidence boss={boss} />;
    case "wipe":
      return (
        <>
          <div className="dossier-boss-heading">
            <BossArtwork boss={boss} />
            <div>
              <h4 className="dossier-boss-title">
                <StatusIcon state="wipe" />
                <span>{boss.bossName}</span>
              </h4>
              <p className="dossier-boss-first-kill">
                Wipe found: {displayDate(boss.wipe.attemptedAt)} ·{" "}
                <DossierCharacterNames characters={boss.wipe.characters} />
              </p>
            </div>
          </div>
          <details>
            <summary>View wipe evidence</summary>
            <dl className="dossier-evidence">
              <div>
                <dt>Attempt</dt>
                <dd>
                  <time dateTime={boss.wipe.attemptedAt}>
                    {displayDate(boss.wipe.attemptedAt)}
                  </time>
                </dd>
              </div>
              <div>
                <dt>Report</dt>
                <dd>
                  <UpstreamIconLink
                    href={boss.wipe.reportUrl}
                    label="View Warcraft Logs wipe report"
                    source="warcraft_logs"
                  />
                </dd>
              </div>
              <div>
                <dt>Characters present</dt>
                <dd>
                  <DossierCharacterNames characters={boss.wipe.characters} />
                </dd>
              </div>
            </dl>
          </details>
        </>
      );
    case "no_logs":
      return (
        <div className="dossier-boss-heading dossier-boss-heading--muted">
          <BossArtwork boss={boss} />
          <div>
            <h4 className="dossier-boss-title">
              <StatusIcon state="no_logs" />
              <span>{boss.bossName}</span>
            </h4>
            <p className="dossier-boss-state">
              No qualifying public logs found
            </p>
          </div>
        </div>
      );
    case "incomplete":
      return (
        <div className="dossier-boss-heading dossier-boss-heading--muted">
          <BossArtwork boss={boss} />
          <div>
            <h4>{boss.bossName}</h4>
            <p className="dossier-boss-state">Evidence incomplete</p>
          </div>
        </div>
      );
  }
}

function RaidArtwork({ raid }: { raid: Raid }) {
  return raid.imageUrl ? (
    <img
      alt=""
      aria-hidden="true"
      className="dossier-raid-artwork"
      decoding="async"
      height="180"
      loading="lazy"
      onError={({ currentTarget }) => {
        currentTarget.hidden = true;
      }}
      onLoad={({ currentTarget }) => {
        currentTarget.hidden = false;
      }}
      src={raid.imageUrl}
      width="800"
    />
  ) : null;
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
          {raids.map((raid) => {
            const hasNoLogs =
              raid.bosses.length > 0 &&
              raid.bosses.every((boss) => boss.state === "no_logs");
            if (hasNoLogs) {
              return (
                <section
                  aria-label={`${raid.raidName} evidence`}
                  className="dossier-raid dossier-raid-no-logs"
                  key={raid.raidId}
                  role="group"
                >
                  <h3>{raid.raidName}</h3>
                  <strong>No logs found</strong>
                  <p>
                    No qualifying public logs found; this does not prove no
                    attempt.
                  </p>
                </section>
              );
            }
            return (
              <section className="dossier-raid" key={raid.raidId}>
                <h3 className="dossier-raid-heading">
                  <RaidArtwork raid={raid} />
                  <span className="dossier-raid-name">{raid.raidName}</span>
                </h3>
                <div className="dossier-boss-list">
                  {raid.bosses.map((boss) => (
                    <article
                      aria-label={`${boss.bossName} evidence`}
                      className={`dossier-boss dossier-boss--${boss.state}`}
                      key={boss.bossId}
                      role="group"
                    >
                      <BossEvidence boss={boss} />
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
