import type { ReactNode } from "react";

type UpstreamIconLinkProps = Readonly<{
  children?: ReactNode;
  evidenceState?: "kill" | "wipe";
  href: string;
  label: string;
  source: "raiderio" | "warcraft_logs";
}>;

export function UpstreamIcon({
  evidenceState,
  source
}: Pick<UpstreamIconLinkProps, "evidenceState" | "source">) {
  if (evidenceState) {
    const label = evidenceState === "kill" ? "Kill report" : "Wipe report";
    return (
      <svg
        aria-label={label}
        className={`upstream-link-icon upstream-link-icon--evidence-${evidenceState}`}
        fill="none"
        role="img"
        viewBox="0 0 16 16"
      >
        <title>{label}</title>
        <rect fill="currentColor" height="14" rx="1.5" width="14" x="1" y="1" />
        <path
          d={
            evidenceState === "kill"
              ? "m4.5 8 2.5 2.5 4.5-5"
              : "m5 5 6 6m0-6-6 6"
          }
          stroke="var(--surface)"
          strokeLinecap="square"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
    );
  }

  const className = `upstream-link-icon upstream-link-icon--${
    source === "warcraft_logs" ? "warcraft-logs" : source
  }`;

  return (
    <img
      alt=""
      aria-hidden="true"
      className={className}
      height="24"
      src={
        source === "warcraft_logs"
          ? "/brand/warcraft-logs-mark.png"
          : "/brand/raiderio-mark.png"
      }
      width="24"
    />
  );
}

export function UpstreamIconLink({
  children,
  evidenceState,
  href,
  label,
  source
}: UpstreamIconLinkProps) {
  const accessibleLabel = `${label} (opens in a new tab)`;
  return (
    <a
      aria-label={accessibleLabel}
      className={`upstream-icon-link upstream-icon-link--${
        source === "warcraft_logs" ? "warcraft-logs" : source
      }${evidenceState ? ` upstream-icon-link--evidence-${evidenceState}` : ""}${
        children ? " upstream-icon-link--labelled" : ""
      }`}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
      title={accessibleLabel}
    >
      {children}
      <UpstreamIcon evidenceState={evidenceState} source={source} />
    </a>
  );
}
