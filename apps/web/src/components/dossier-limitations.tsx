import type {
  DossierLimitation,
  DossierLimitationAffects
} from "@slashwho/contracts";

import { DossierCharacterName } from "./dossier-character-name";
import { CharacterProfileLinks } from "./profile-links";

type DossierLimitationsProps = Readonly<{
  limitations: readonly DossierLimitation[];
}>;

// A farming alt can withhold kills on every boss of a dozen raids. The first
// few say what kind of shortfall it is; the count says how far it reaches.
const ENCOUNTERS_SHOWN = 6;

const SOURCE_LABELS: Record<DossierLimitation["source"], string> = {
  warcraft_logs: "Warcraft Logs",
  raiderio: "Raider.IO",
  blizzard: "Blizzard"
};

const AFFECTS_LABELS: Record<DossierLimitationAffects, string> = {
  kill_history: "Kill and wipe history",
  parses: "Parses",
  world_ranks: "Historic world ranks",
  cutting_edge: "Cutting Edge status",
  hidden_kills: "Kills not shown"
};

type LimitationGroup = Readonly<{
  key: string;
  first: DossierLimitation;
  items: readonly DossierLimitation[];
}>;

/**
 * One entry per shortfall, listing every character it applies to. A capped
 * roster repeats the same sentence once per character otherwise, and the
 * differences a reviewer needs -- who, when, which raids -- get lost in it.
 */
function groupLimitations(
  limitations: readonly DossierLimitation[]
): readonly LimitationGroup[] {
  const groups = new Map<string, DossierLimitation[]>();
  for (const limitation of limitations) {
    const key = [
      limitation.source,
      limitation.code,
      limitation.recovery,
      limitation.message
    ].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), limitation]);
  }
  return [...groups].map(([key, items]) => ({ key, first: items[0]!, items }));
}

export function DossierLimitations({ limitations }: DossierLimitationsProps) {
  if (limitations.length === 0) return null;

  return (
    <section
      className="dossier-panel dossier-limitations"
      aria-labelledby="limitations-heading"
    >
      <h2 className="section-heading" id="limitations-heading">
        Data limitations
      </h2>
      <p className="dossier-limitations-intro">
        Shortfalls in the evidence shown now. A collection already under way
        re-reads what the last one missed, so its old shortfalls are left out
        until it finishes.
      </p>
      <ul className="dossier-limitation-list">
        {groupLimitations(limitations).map(({ key, first, items }) => (
          <li className="dossier-limitation" key={key}>
            <p className="dossier-limitation-message">{first.message}</p>
            <dl className="dossier-limitation-facts">
              <div>
                <dt>Source</dt>
                <dd>{SOURCE_LABELS[first.source]}</dd>
              </div>
              <div>
                <dt>Affects</dt>
                <dd>{AFFECTS_LABELS[first.affects]}</dd>
              </div>
              <div>
                <dt>Recovery</dt>
                <dd>
                  {first.recovery === "none"
                    ? "Waiting will not change this"
                    : "Retries automatically"}
                </dd>
              </div>
            </dl>
            <ul className="dossier-limitation-subjects">
              {items.map((limitation, index) => (
                <li key={`${limitation.character?.name ?? "dossier"}-${index}`}>
                  <LimitationSubject limitation={limitation} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LimitationSubject({
  limitation
}: Readonly<{ limitation: DossierLimitation }>) {
  return (
    <>
      <div className="dossier-limitation-subject">
        {limitation.character ? (
          <span className="dossier-limitation-character">
            <DossierCharacterName character={limitation.character} />
            <CharacterProfileLinks
              character={{
                key: limitation.character,
                displayName: limitation.character.name
              }}
            />
          </span>
        ) : (
          <span className="dossier-limitation-character">Whole dossier</span>
        )}
        <span>
          {"Observed "}
          <time dateTime={limitation.observedAt}>
            {formatTimestamp(limitation.observedAt)}
          </time>
        </span>
        {limitation.recovery === "automatic" && limitation.retryAt ? (
          <span>
            {"Retry due "}
            <time dateTime={limitation.retryAt}>
              {formatTimestamp(limitation.retryAt)}
            </time>
          </span>
        ) : null}
      </div>
      <LimitationEncounters encounters={limitation.encounters} />
    </>
  );
}

function LimitationEncounters({
  encounters
}: Readonly<{ encounters: DossierLimitation["encounters"] }>) {
  if (!encounters?.length) return null;
  const shown = encounters.slice(0, ENCOUNTERS_SHOWN);
  const hidden = encounters.slice(ENCOUNTERS_SHOWN);
  const hiddenKills = hidden.reduce((sum, entry) => sum + entry.kills, 0);
  return (
    <ul
      className="dossier-limitation-encounters"
      aria-label="Affected encounters"
    >
      {shown.map((entry) => (
        <li key={`${entry.raidName}-${entry.bossName ?? ""}`}>
          <span>
            {entry.bossName
              ? `${entry.raidName} · ${entry.bossName}`
              : entry.raidName}
          </span>
          <span className="dossier-limitation-kills">
            {killCount(entry.kills)}
          </span>
        </li>
      ))}
      {hidden.length > 0 ? (
        <li className="dossier-limitation-more">
          {`and ${hidden.length} more ${hidden.length === 1 ? "encounter" : "encounters"} (${killCount(hiddenKills)})`}
        </li>
      ) : null}
    </ul>
  );
}

function killCount(kills: number): string {
  return `${kills} ${kills === 1 ? "kill" : "kills"}`;
}

function formatTimestamp(value: string): string {
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC"
  }).format(new Date(value))} UTC`;
}
