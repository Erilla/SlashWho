import type { ApplicantDossier } from "@slashwho/contracts";

import { DossierCharacterNameByName } from "./dossier-character-name";
import { parseColour } from "./parse-colour";
import { UpstreamIcon } from "./upstream-icon-link";

type KillBoss = Extract<
  ApplicantDossier["raids"][number]["bosses"][number],
  { state: "kill" }
>;
type ApplicantDossierCharacterParses = KillBoss["bestParses"][number];
type ApplicantDossierParseMetric = ApplicantDossierCharacterParses["damage"];

type DossierParseListProps = Readonly<{
  label: string;
  parses: readonly ApplicantDossierCharacterParses[];
  showCharacterName?: boolean;
}>;

type MetricName = "Damage" | "Healing" | "Boss damage";

function displayPercentile(percentile: number): string {
  const truncated = Math.trunc(percentile * 10) / 10;
  return Number.isInteger(truncated)
    ? `${truncated}${ordinalSuffix(truncated)} percentile`
    : `${truncated.toFixed(1)} percentile`;
}

function ordinalSuffix(value: number): string {
  const remainder = value % 100;
  if (remainder >= 11 && remainder <= 13) return "th";
  switch (value % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function ParseMetric({
  metric,
  name
}: {
  metric: ApplicantDossierParseMetric;
  name: MetricName;
}) {
  if (metric.state !== "available") {
    const label = `${name} ${metric.state.replace("_", " ")}`;
    return (
      <span className="dossier-parse-metric dossier-parse-metric--neutral">
        {label}
      </span>
    );
  }

  const label = `${name} ${displayPercentile(metric.percentile)}`;
  return (
    <a
      aria-label={label}
      className={`dossier-parse-metric dossier-parse-metric--${parseColour(metric.percentile)}`}
      href={metric.reportUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      <UpstreamIcon source="warcraft_logs" />
      {label}
    </a>
  );
}

export function DossierParseList({
  label,
  parses,
  showCharacterName = true
}: DossierParseListProps) {
  return (
    <section aria-label={label} className="dossier-parse-list">
      <h5>{label}</h5>
      {parses.length === 0 ? (
        <p className="dossier-parse-empty">No parse values were available.</p>
      ) : (
        <ul>
          {parses.map((parse) => (
            <li
              aria-label={`${parse.character} parses`}
              key={parse.character}
              role="group"
            >
              {showCharacterName ? (
                <DossierCharacterNameByName name={parse.character} />
              ) : null}
              <span className="dossier-parse-metrics">
                <ParseMetric metric={parse.damage} name="Damage" />
                <ParseMetric metric={parse.healing} name="Healing" />
                <ParseMetric metric={parse.bossDamage} name="Boss damage" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
