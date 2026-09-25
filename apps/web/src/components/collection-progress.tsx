"use client";

import type {
  CollectionPhase,
  DossierLimitationCode
} from "@slashwho/contracts";
import { useEffect, useRef, useState } from "react";

type CollectionProgressProps = Readonly<{
  phases: readonly CollectionPhase[];
  /** Who the run is collecting, so an announcement makes sense out of context. */
  subject: string;
  /**
   * Whether step transitions are read aloud. A view that updates many runs at
   * once, such as the operator monitor, turns this off rather than stream them.
   */
  announce?: boolean;
}>;

const stepLabel: Record<CollectionPhase["id"], string> = {
  warcraft_logs_identity_resolution: "Resolving the character on Warcraft Logs",
  warcraft_logs_history: "Scanning report history",
  warcraft_logs_tier_bests: "Reading tier bests",
  warcraft_logs_fight_parses: "Reading per-fight parses",
  warcraft_logs_ranking_identities: "Matching ranking identities",
  raiderio_rankings: "Reading Raider.IO rankings",
  blizzard_achievements: "Reading Blizzard achievements",
  publication: "Publishing evidence"
};

// "Skipped" makes no claim about why: a settled tier (#314) and a limitation
// that ended the run early both skip what remains.
const stateLabel: Record<CollectionPhase["state"], string> = {
  pending: "to do",
  active: "in progress",
  completed: "done",
  skipped: "skipped",
  limited: "limited",
  failed: "failed",
  cancelled: "cancelled"
};

const limitationLabel: Record<DossierLimitationCode, string> = {
  not_found: "not found",
  private: "private",
  rate_limited: "rate limited",
  points_budget_low: "points budget low",
  collection_failed: "collection failed",
  request_cap: "request cap reached",
  unavailable: "unavailable",
  schema_changed: "provider response changed",
  invalid_fight_timestamp: "invalid fight timestamp",
  parse_private: "private",
  parse_rate_limited: "rate limited",
  parse_request_cap: "request cap reached",
  parse_unavailable: "unavailable",
  parse_schema_drift: "provider response changed",
  parse_identity_unmatched: "identity unmatched",
  current_content_window_unknown: "current content window unknown",
  current_content_evidence_withheld: "current content withheld",
  unmatched_encounter: "unmatched encounter"
};

/** The one line a reviewer wants: what the run is doing right now. */
export function currentStep(phases: readonly CollectionPhase[]): string {
  const active = phases.find((phase) => phase.state === "active");
  if (active) return stepLabel[active.id];
  const stopped = phases.find(
    (phase) => phase.state === "failed" || phase.state === "cancelled"
  );
  if (stopped) return `Stopped at ${stepLabel[stopped.id]}`;
  if (phases.every((phase) => phase.state === "pending"))
    return "Waiting to start";
  const next = phases.find((phase) => phase.state === "pending");
  return next ? `Next: ${stepLabel[next.id]}` : "Finishing";
}

function stepState(phase: CollectionPhase): string {
  return phase.limitationCode
    ? `${stateLabel[phase.state]}, ${limitationLabel[phase.limitationCode]}`
    : stateLabel[phase.state];
}

/**
 * The steps of the run collecting a character, collapsed to the current one.
 * The full checklist is for when something looks stuck.
 */
export function CollectionProgress({
  phases,
  subject,
  announce = true
}: CollectionProgressProps) {
  const current = currentStep(phases);
  const running = phases.some((phase) => phase.state === "active");
  // Empty until the run moves on. A live region reads changes, not what it
  // held when it mounted, and an idle one keeps the character's name from
  // appearing twice on the page.
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef(current);
  useEffect(() => {
    if (announced.current === current) return;
    announced.current = current;
    setAnnouncement(`${subject}: ${current}`);
  }, [current, subject]);

  return (
    <div className="collection-progress">
      <details role="group">
        <summary className="collection-progress-summary">
          {running ? (
            <svg
              aria-hidden="true"
              className="dossier-loading-spinner collection-progress-spinner"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="8" />
            </svg>
          ) : null}
          <span>{current}</span>
        </summary>
        <ol className="collection-progress-steps">
          {phases.map((phase) => (
            <li
              className="collection-progress-step"
              data-state={phase.state}
              key={phase.id}
            >
              <span>{stepLabel[phase.id]}</span>
              <span className="collection-progress-state">
                <span className="visually-hidden">: </span>
                {stepState(phase)}
              </span>
            </li>
          ))}
        </ol>
      </details>
      {/* Only a step transition is announced, so a poll within a step leaves
          this text -- and a screen reader -- alone. Outside the disclosure: a
          closed one hides its content. */}
      {announce ? (
        <p className="visually-hidden" role="status">
          {announcement}
        </p>
      ) : null}
    </div>
  );
}
