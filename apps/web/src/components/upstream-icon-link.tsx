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

  if (source === "raiderio") {
    return (
      <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
        <path d="M12 2 14 3.4l2.4-.1.9 2.2 2.1 1.2-.5 2.3 1.1 2.1-1.7 1.7.1 2.4-2.2.9-1.2 2.1-2.3-.5-2.1 1.1-1.7-1.7-2.4.1-.9-2.2-2.1-1.2.5-2.3L3 9l1.7-1.7-.1-2.4 2.2-.9L8 1.9l2.3.5L12 2Z" />
        <path d="m12 4.7 1.2 4.5 3.8 1.8-3.8 1.8-1.2 4.5-1.2-4.5L7 11l3.8-1.8L12 4.7Z" />
        <path
          d="m11.1 8.4.9-2.1.9 2.1-.9 4.7-.9-4.7Z"
          fill="var(--surface-raised)"
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
      <path d="m4.1 5.4 1.7-1.1 5.1 5.1-1.1 1.7-5.7-4.2Zm15.8 0-1.7-1.1-5.1 5.1 1.1 1.7 5.7-4.2ZM8.2 19.7l1.7-1.1 4.1-6.2-1.5-1.5-5.8 6.8 1.5 2Zm7.6 0-1.7-1.1-4.1-6.2 1.5-1.5 5.8 6.8-1.5 2Z" />
      <path d="M12 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm0 1.8a4.7 4.7 0 1 1 0 9.4 4.7 4.7 0 0 1 0-9.4Z" />
      <path d="M7.4 12.3h2l1-2.4 1.3 4 1.2-2.2h3.7v1.1h-4.4l-.7 1.3-1.2-3.4-.5 1.7H7.4v-.1Z" />
      <path d="M11.1 3.8h1.8v2.1h-1.8V3.8Zm0 14.3h1.8v2.1h-1.8v-2.1Z" />
    </svg>
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
