import type { ApplicantDossier } from "@slashwho/contracts";

import { DossierCharacterNameByName } from "./dossier-character-name";
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
  showCharacterName?: boolean;
}>;

type MetricName = "Damage" | "Healing" | "Boss Dam";

function displayPercentileValue(percentile: number): string {
  // Parse source values remain fractional through contracts and persistence.
  // The dossier alone presents them as nearest whole numbers.
  return `${Math.round(percentile)}`;
}

function ParseMetric({
  metric,
  name,
  loading,
  spec
}: {
  metric: ApplicantDossierParseMetric;
  name: MetricName;
  loading: boolean;
  spec?: ApplicantDossierCharacterParses["spec"];
}) {
  if (metric.state !== "available") {
    return (
      <div className="dossier-parse-metric dossier-parse-metric--neutral">
        <span className="dossier-parse-metric-label">{name}</span>
        {loading && metric.state === "unavailable" ? (
          <span
            aria-label="Loading parse"
            className="dossier-parse-spinner"
            role="img"
          />
        ) : (
          <span className="dossier-parse-metric-value">-</span>
        )}
      </div>
    );
  }

  const label = `${name} ${displayPercentileValue(metric.percentile)} percentile${spec ? ` (${spec.name})` : ""}`;
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
        {displayPercentileValue(metric.percentile)}
        {spec ? (
          <img
            alt={`${spec.name} specialization`}
            className="dossier-parse-spec-icon"
            height={20}
            src={spec.iconUrl}
            width={20}
          />
        ) : null}
      </span>
    </a>
  );
}

export function DossierParseList({
  label,
  parses,
  loading = false,
  showCharacterName = true
}: DossierParseListProps) {
  return (
    <section
      aria-label={label}
      className={`dossier-parse-list${showCharacterName ? " dossier-parse-list--with-character-name" : ""}`}
    >
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
                <ParseMetric
                  loading={loading}
                  metric={parse.damage}
                  name="Damage"
                  spec={parse.spec}
                />
                <ParseMetric
                  loading={loading}
                  metric={parse.healing}
                  name="Healing"
                  spec={parse.spec}
                />
                <ParseMetric
                  loading={loading}
                  metric={parse.bossDamage}
                  name="Boss Dam"
                  spec={parse.spec}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
