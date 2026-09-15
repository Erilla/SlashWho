import type { ReactNode } from "react";

type UpstreamIconLinkProps = Readonly<{
  children?: ReactNode;
  evidenceState?: "kill" | "wipe";
  href: string;
  label: string;
  source: "raiderio" | "warcraft_logs";
}>;

export function UpstreamIcon({
  source
}: Pick<UpstreamIconLinkProps, "source">) {
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
      <UpstreamIcon source={source} />
    </a>
  );
}
