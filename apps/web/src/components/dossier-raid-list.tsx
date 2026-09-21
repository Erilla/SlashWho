import type { ApplicantDossier } from "@slashwho/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { BossArtwork } from "./boss-artwork";
import { DossierCharacterNames } from "./dossier-character-name";
import { DossierParseList } from "./dossier-parse-list";
import { UpstreamIcon, UpstreamIconLink } from "./upstream-icon-link";
import { GuildProfileLinks } from "./profile-links";

type Raid = ApplicantDossier["raids"][number];
type Boss = Raid["bosses"][number];
type KillBoss = Extract<Boss, { state: "kill" }>;
type WipeEvidence = Extract<Boss, { state: "wipe" }>["wipe"];
type WipeCharacter = WipeEvidence["characters"][number];
type DossierReport = NonNullable<KillBoss["firstKill"]["reports"]>[number];
type WipeGroup = Readonly<{
  attemptedAt: string;
  reportUrls: readonly string[];
  reports: readonly DossierReport[];
  characters: readonly WipeCharacter[];
}>;

type DossierRaidListProps = Readonly<{
  raids: ApplicantDossier["raids"];
  limitations?: ApplicantDossier["limitations"];
  loading?: boolean;
}>;

function ReportLinks({ evidence }: { evidence: KillBoss["firstKill"] }) {
  const urls =
    evidence.reportUrls ?? (evidence.reportUrl ? [evidence.reportUrl] : []);
  const reports =
    evidence.reports ??
    urls.map((reportUrl) => ({
      reportUrl,
      source:
        evidence.guild !== null && reportUrl === evidence.reportUrl
          ? ("guild_log" as const)
          : ("personal_log" as const),
      uploader: null,
      guild:
        evidence.guild !== null && reportUrl === evidence.reportUrl
          ? evidence.guild
          : null
    }));
  if (reports.length === 0) return <>Report: —</>;
  return <ReportControl evidenceState="kill" reports={reports} />;
}

function ReportControl({
  evidenceState,
  reports
}: {
  evidenceState: "kill" | "wipe";
  reports: readonly DossierReport[];
}) {
  if (reports.length === 1) {
    return (
      <UpstreamIconLink
        evidenceState={evidenceState}
        href={reports[0]!.reportUrl}
        label={`View Warcraft Logs ${evidenceState === "wipe" ? "wipe " : ""}report`}
        source="warcraft_logs"
      />
    );
  }
  return <ReportMenu evidenceState={evidenceState} reports={reports} />;
}

function reportName(report: {
  source: "guild_log" | "personal_log";
  uploader: string | null;
  guild?: { name: string } | null;
}) {
  return report.source === "guild_log"
    ? (report.guild?.name ?? "Guild log")
    : (report.uploader ?? "Unknown uploader");
}

function reportDetail(report: Parameters<typeof reportName>[0]) {
  return report.source === "guild_log"
    ? `Guild log uploaded by ${report.uploader ?? "Unknown uploader"}`
    : "Personal log";
}

function reportLabel(report: Parameters<typeof reportName>[0]) {
  return report.source === "guild_log"
    ? `${reportName(report)} — ${reportDetail(report)}`
    : `${reportName(report)}, personal log`;
}

function guildReportsFirst(reports: readonly DossierReport[]) {
  return [...reports].sort((a, b) =>
    a.source === b.source ? 0 : a.source === "guild_log" ? -1 : 1
  );
}

function ReportMenu({
  evidenceState,
  reports
}: {
  evidenceState: "kill" | "wipe";
  reports: readonly DossierReport[];
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [isBrowser, setIsBrowser] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();
  const tooltipId = useId();
  const count = reports.length;
  const orderedReports = guildReportsFirst(reports);

  useEffect(() => setIsBrowser(true), []);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    []
  );

  useEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    const positionMenu = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const bounds = trigger.getBoundingClientRect();
      const gutter = 16;
      const width = Math.min(320, window.innerWidth - gutter * 2);
      const height = Math.min(
        window.innerHeight - gutter * 2,
        Math.max(160, count * 64 + 16)
      );
      const left = Math.max(
        width / 2 + gutter,
        Math.min(
          bounds.left + bounds.width / 2,
          window.innerWidth - width / 2 - gutter
        )
      );
      const below = bounds.bottom + 6;
      const top =
        below + height <= window.innerHeight - gutter ||
        bounds.top < height + gutter
          ? below
          : Math.max(gutter, bounds.top - height - 6);
      setMenuPosition({ left, top });
    };

    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [count, open]);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openMenu = () => {
    cancelClose();
    setOpen(true);
  };
  const closeMenu = () => {
    cancelClose();
    setOpen(false);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(closeMenu, 120);
  };
  const containsMenuFocus = (target: EventTarget | null) =>
    target instanceof Node &&
    (triggerRef.current?.contains(target) || menuRef.current?.contains(target));

  return (
    <span className="dossier-report-menu">
      <button
        aria-controls={menuId}
        aria-describedby={tooltipId}
        aria-expanded={open}
        aria-label={`Choose from ${count} ${evidenceState} reports`}
        className={`upstream-icon-link upstream-icon-link--warcraft-logs upstream-icon-link--evidence-${evidenceState} dossier-report-menu-trigger`}
        onBlur={(event) => {
          if (!containsMenuFocus(event.relatedTarget)) scheduleClose();
        }}
        onClick={openMenu}
        onFocus={openMenu}
        onKeyDown={(event) => {
          if (event.key === "Escape") closeMenu();
        }}
        onPointerEnter={openMenu}
        onPointerLeave={scheduleClose}
        ref={triggerRef}
        type="button"
      >
        <UpstreamIcon evidenceState={evidenceState} source="warcraft_logs" />
      </button>
      <span
        className="dossier-report-menu-tooltip"
        id={tooltipId}
        role="tooltip"
      >
        {count} reports found
      </span>
      {open && isBrowser && menuPosition
        ? createPortal(
            <ul
              aria-label={`${evidenceState === "kill" ? "Kill" : "Wipe"} reports`}
              className="dossier-report-menu-list"
              id={menuId}
              onBlur={(event) => {
                if (!containsMenuFocus(event.relatedTarget)) scheduleClose();
              }}
              onFocus={cancelClose}
              onPointerEnter={cancelClose}
              onPointerLeave={scheduleClose}
              ref={menuRef}
              style={menuPosition}
            >
              {orderedReports.map((report) => (
                <li key={report.reportUrl}>
                  <a
                    aria-label={reportLabel(report)}
                    href={report.reportUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <span>{reportName(report)}</span>
                    <small>{reportDetail(report)}</small>
                  </a>
                </li>
              ))}
            </ul>,
            document.body
          )
        : null}
    </span>
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
                  <li>
                    <ReportControl
                      evidenceState="wipe"
                      reports={wipe.reports}
                    />
                  </li>
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
      reports: DossierReport[];
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
      reports: [],
      characters: [],
      characterKeys: new Set<string>()
    };
    const wipeReport = reportKey(wipe.reportUrl);
    if (!reportKeys.has(wipeReport)) {
      reportKeys.add(wipeReport);
      group.reportUrls.push(wipe.reportUrl);
      group.reports.push({
        reportUrl: wipe.reportUrl,
        source: wipe.source ?? "personal_log",
        uploader: wipe.uploader ?? null,
        guild: wipe.guild ?? null
      });
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
    .map(({ attemptedAt, reportUrls, reports, characters }) => ({
      attemptedAt,
      reportUrls,
      reports: [...reports].sort((a, b) =>
        a.source === b.source ? 0 : a.source === "guild_log" ? -1 : 1
      ),
      characters
    }));
}

function KillEvidence({ boss, loading }: { boss: KillBoss; loading: boolean }) {
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
        <BossArtwork bossName={boss.bossName} imageUrl={boss.imageUrl} />
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
      <DossierParseList
        label="First kill parses"
        loading={loading}
        parses={firstKill.parses}
      />
      <DossierParseList
        label="Best parses"
        loading={loading}
        parses={boss.bestParses}
      />
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
                        {displayGuild(evidence.guild)}
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
                        <ul className="dossier-report-links">
                          <li>
                            <ReportLinks evidence={evidence} />
                          </li>
                          {groupWipes(wipes).map((wipe) => (
                            <li key={wipe.attemptedAt}>
                              <ReportControl
                                evidenceState="wipe"
                                reports={wipe.reports}
                              />
                            </li>
                          ))}
                        </ul>
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
                          loading={loading}
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

function BossEvidence({ boss, loading }: { boss: Boss; loading: boolean }) {
  switch (boss.state) {
    case "kill":
      return <KillEvidence boss={boss} loading={loading} />;
    case "wipe":
      return (
        <>
          <div className="dossier-boss-heading">
            <BossArtwork bossName={boss.bossName} imageUrl={boss.imageUrl} />
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
          <BossArtwork bossName={boss.bossName} imageUrl={boss.imageUrl} />
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
          <BossArtwork bossName={boss.bossName} imageUrl={boss.imageUrl} />
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
  limitations = [],
  loading = false
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
                  {[...raid.bosses].reverse().map((boss) => (
                    <article
                      aria-label={`${boss.bossName} evidence`}
                      className={`dossier-boss dossier-boss--${boss.state}`}
                      key={boss.bossId}
                      role="group"
                    >
                      <BossEvidence boss={boss} loading={loading} />
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
