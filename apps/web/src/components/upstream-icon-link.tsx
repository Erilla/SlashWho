import type { ReactNode } from "react";

type UpstreamIconLinkProps = Readonly<{
  children?: ReactNode;
  href: string;
  label: string;
  source: "raiderio" | "warcraft_logs";
}>;

function UpstreamIcon({ source }: Pick<UpstreamIconLinkProps, "source">) {
  const className = `upstream-link-icon upstream-link-icon--${
    source === "warcraft_logs" ? "warcraft-logs" : source
  }`;

  if (source === "raiderio") {
    return (
      <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
        <path d="M12 2.5 20 7v10l-8 4.5L4 17V7l8-4.5Z" />
        <path d="m8 15 4-7 4 7-4-2-4 2Z" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
      <path d="M4 19V9h4v10H4Zm6 0V4h4v15h-4Zm6 0v-7h4v7h-4Z" />
    </svg>
  );
}

export function UpstreamIconLink({
  children,
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
      }${children ? " upstream-icon-link--labelled" : ""}`}
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
