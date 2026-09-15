import type { ApplicantDossier } from "@slashwho/contracts";

import { parseColour } from "./parse-colour";

type KillBoss = Extract<
  ApplicantDossier["raids"][number]["bosses"][number],
  { state: "kill" }
>;
type ApplicantDossierCharacterParses = KillBoss["bestParses"][number];
type ApplicantDossierParseMetric = ApplicantDossierCharacterParses["damage"];

type DossierParseListProps = Readonly<{
  label: string;
  parses: readonly ApplicantDossierCharacterParses[];
  loading?: boolean;
}>;

type MetricName = "Damage" | "Healing" | "Boss Damage";

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
  name,
  loading
}: {
  metric: ApplicantDossierParseMetric;
  name: MetricName;
  loading: boolean;
}) {
  if (metric.state !== "available") {
    return (
      <div className="dossier-parse-metric dossier-parse-metric--neutral">
        <span className="dossier-parse-metric-label">{name}</span>
        {loading && metric.state === "unavailable" ? (
          <span
            aria-label="Loading parse"
            className="dossier-parse-spinner"
            role="status"
          />
        ) : (
          <span className="dossier-parse-metric-value">-</span>
        )}
      </div>
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
      <span className="dossier-parse-metric-label">{name}</span>
      <span className="dossier-parse-metric-value">
        {displayPercentile(metric.percentile)}
      </span>
    </a>
  );
}

export function DossierParseList({
  label,
  parses,
  loading = false
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
              <span className="dossier-parse-character-spec">
                {parse.classSpec ?? "—"}
              </span>
              <span className="dossier-parse-metrics">
                <ParseMetric
                  loading={loading}
                  metric={parse.damage}
                  name="Damage"
                />
                <ParseMetric
                  loading={loading}
                  metric={parse.healing}
                  name="Healing"
                />
                <ParseMetric
                  loading={loading}
                  metric={parse.bossDamage}
                  name="Boss Damage"
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
