import type { ApplicantDossier } from "@slashwho/contracts";

import { DossierCharacterNames } from "./dossier-character-name";
import { DossierMediaFallback } from "./dossier-media-fallback";
import { DossierParseList } from "./dossier-parse-list";
import { UpstreamIconLink } from "./upstream-icon-link";
import { GuildProfileLinks } from "./profile-links";

type Raid = ApplicantDossier["raids"][number];
type Boss = Raid["bosses"][number];
type KillBoss = Extract<Boss, { state: "kill" }>;
type WipeEvidence = Extract<Boss, { state: "wipe" }>["wipe"];
type WipeCharacter = WipeEvidence["characters"][number];
type WipeGroup = Readonly<{
  attemptedAt: string;
  reportUrls: readonly string[];
  characters: readonly WipeCharacter[];
}>;

type DossierRaidListProps = Readonly<{
  raids: ApplicantDossier["raids"];
  limitations?: ApplicantDossier["limitations"];
}>;

function ReportLinks({
  evidence,
  wipes = []
}: {
  evidence: KillBoss["firstKill"];
  wipes?: readonly WipeEvidence[];
}) {
  const urls =
    evidence.reportUrls ?? (evidence.reportUrl ? [evidence.reportUrl] : []);
  const wipeUrls = groupWipes(wipes).flatMap((wipe) => wipe.reportUrls);
  if (urls.length === 0 && wipes.length === 0) return <>Report: —</>;
  return (
    <ul className="dossier-report-links">
      {urls.map((url, index) => (
        <li key={url}>
          <UpstreamIconLink
            evidenceState="kill"
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
      {wipeUrls.map((url) => (
        <li key={url}>
          <UpstreamIconLink
            evidenceState="wipe"
            href={url}
            label="View Warcraft Logs wipe report"
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

function WipeEvidenceList({
  wipes
}: {
  wipes: readonly WipeEvidence[] | undefined;
}) {
  return (
    <>
      {groupWipes(wipes ?? []).map((wipe) => (
        <div
          className="dossier-evidence-row"
          key={wipe.attemptedAt.slice(0, 10)}
        >
          <StatusIcon state="wipe" />
          <dl className="dossier-evidence">
            <div>
              <dt>Wipe</dt>
              <dd>
                <time dateTime={wipe.attemptedAt}>
                  {displayDate(wipe.attemptedAt)}
                </time>
              </dd>
            </div>
            <div>
              <dt>Report</dt>
              <dd>
                <ul className="dossier-report-links">
                  {wipe.reportUrls.map((url) => (
                    <li key={url}>
                      <UpstreamIconLink
                        evidenceState="wipe"
                        href={url}
                        label="View Warcraft Logs wipe report"
                        source="warcraft_logs"
                      />
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
            <div>
              <dt>Characters present</dt>
              <dd>
                <DossierCharacterNames characters={wipe.characters} />
              </dd>
            </div>
          </dl>
        </div>
      ))}
    </>
  );
}

function reportKey(url: string): string {
  return url.split("#", 1)[0] ?? url;
}

function killReportKeys(evidence: KillBoss["firstKill"]): Set<string> {
  return new Set(
    [evidence.reportUrl, ...(evidence.reportUrls ?? [])]
      .filter((url): url is string => url !== null)
      .map(reportKey)
  );
}

function sortWipes(wipes: readonly WipeEvidence[]): WipeEvidence[] {
  return [...wipes].sort(
    (a, b) =>
      b.attemptedAt.localeCompare(a.attemptedAt) ||
      b.reportUrl.localeCompare(a.reportUrl)
  );
}

function groupWipes(wipes: readonly WipeEvidence[]): WipeGroup[] {
  const groups = new Map<
    string,
    {
      attemptedAt: string;
      reportUrls: string[];
      characters: WipeCharacter[];
      characterKeys: Set<string>;
    }
  >();
  const reportKeys = new Set<string>();

  for (const wipe of sortWipes(wipes)) {
    const date = wipe.attemptedAt.slice(0, 10);
    const group = groups.get(date) ?? {
      attemptedAt: wipe.attemptedAt,
      reportUrls: [],
      characters: [],
      characterKeys: new Set<string>()
    };
    const wipeReport = reportKey(wipe.reportUrl);
    if (!reportKeys.has(wipeReport)) {
      reportKeys.add(wipeReport);
      group.reportUrls.push(wipe.reportUrl);
    }
    for (const character of wipe.characters) {
      const characterKey = `${character.region}/${character.realm}/${character.name}`;
      if (!group.characterKeys.has(characterKey)) {
        group.characterKeys.add(characterKey);
        group.characters.push(character);
      }
    }
    groups.set(date, group);
  }

  return [...groups.values()]
    .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt))
    .map(({ attemptedAt, reportUrls, characters }) => ({
      attemptedAt,
      reportUrls,
      characters
    }));
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
  const firstKills = [...(boss.firstKills ?? [boss.firstKill])].sort(
    (a, b) =>
      a.killedAt.localeCompare(b.killedAt) ||
      (a.reportUrl ?? "").localeCompare(b.reportUrl ?? "")
  );
  const firstKill = firstKills[0] ?? boss.firstKill;
  const killGroups = firstKills.map((evidence) => ({
    evidence,
    wipes: [] as WipeEvidence[]
  }));

  for (const wipe of boss.wipes ?? []) {
    const wipeReport = reportKey(wipe.reportUrl);
    const subsequentKill = killGroups
      .filter(
        ({ evidence }) =>
          evidence.killedAt > wipe.attemptedAt &&
          !killReportKeys(evidence).has(wipeReport)
      )
      .sort(
        (a, b) =>
          a.evidence.killedAt.localeCompare(b.evidence.killedAt) ||
          (a.evidence.reportUrl ?? "").localeCompare(b.evidence.reportUrl ?? "")
      )[0];

    if (subsequentKill) subsequentKill.wipes.push(wipe);
  }

  for (const group of killGroups) group.wipes = sortWipes(group.wipes);
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
      <DossierParseList label="First kill parses" parses={firstKill.parses} />
      <DossierParseList label="Best shown parses" parses={boss.bestParses} />
      <details>
        <summary>View kill evidence</summary>
        <section aria-label="Kill evidence" className="dossier-evidence-list">
          {killGroups.map(({ evidence, wipes }, index) => {
            const isChronologicalFirst = index === 0;
            return (
              <div key={`${evidence.killedAt}-${evidence.reportUrl ?? index}`}>
                <div className="dossier-evidence-row">
                  <StatusIcon state="kill" />
                  <dl
                    className={`dossier-evidence${
                      isChronologicalFirst ? " dossier-evidence-first-kill" : ""
                    }`}
                  >
                    <div>
                      <dt>{isChronologicalFirst ? "First kill" : "Kill"}</dt>
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
                        <ReportLinks evidence={evidence} wipes={wipes} />
                      </dd>
                    </div>
                    <div>
                      <dt>Characters present</dt>
                      <dd>
                        <DossierCharacterNames
                          characters={evidence.characters}
                        />
                      </dd>
                    </div>
                    <div>
                      <dt>Parses</dt>
                      <dd>
                        <DossierParseList
                          label={`${isChronologicalFirst ? "First kill" : "Kill"} parses`}
                          parses={evidence.parses}
                          showCharacterName={false}
                        />
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            );
          })}
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
            <section
              aria-label="Wipe evidence"
              className="dossier-evidence-list"
            >
              <WipeEvidenceList wipes={sortWipes(boss.wipes ?? [boss.wipe])} />
            </section>
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

export function DossierRaidList({
  raids,
  limitations = []
}: DossierRaidListProps) {
  const unknown = limitations.some(
    (item) => item.code === "current_content_window_unknown"
  );
  const legacy = limitations.some(
    (item) => item.code === "current_content_evidence_withheld"
  );
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
          {legacy
            ? unknown
              ? "Some public Mythic evidence is withheld because it falls outside current-content windows or its eligibility has not been reviewed."
              : "Public Mythic evidence outside current-content windows is withheld."
            : unknown
              ? "Some public Mythic evidence is withheld because its current-content eligibility is not established."
              : "No public historic Mythic evidence was found."}
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
