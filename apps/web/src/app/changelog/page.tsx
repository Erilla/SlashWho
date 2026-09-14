import Link from "next/link";

import {
  loadDeploymentChangelog,
  type ChangelogResult
} from "../../server/deployment-changelog";

export const revalidate = 300;
export const dynamic = "force-dynamic";

type ChangelogLink = Readonly<{ href: string; label: string }>;

function changelogDateText(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false
  }).format(new Date(value));
}

function renderLinks(links: readonly ChangelogLink[]) {
  if (links.length === 0) return null;
  return (
    <ul className="changelog-links" aria-label="Related repository references">
      {links.map((link) => (
        <li key={link.href}>
          <Link href={link.href} target="_blank" rel="noreferrer">
            {link.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function ChangelogPage() {
  const changelog: ChangelogResult = await loadDeploymentChangelog();

  return (
    <main className="page-shell document-page">
      <h1>Deployment changelog</h1>
      {changelog.kind === "unavailable" ? (
        <section className="empty-state">
          <p>{changelog.reason}</p>
        </section>
      ) : changelog.entries.length === 0 ? (
        <section className="empty-state">
          <p>
            Deployment changelog entries are not available yet. This page will
            populate automatically once successful production deployments are
            recorded.
          </p>
        </section>
      ) : (
        <>
          <p className="changelog-subheading">
            Source: {changelog.repository} •{" "}
            {changelog.source.replace("_", " ")}
          </p>
          <ol className="changelog-list">
            {changelog.entries.map((entry) => (
              <li key={entry.id} className="changelog-entry">
                <div className="changelog-entry-heading">
                  <strong>{entry.summary}</strong>
                  <time dateTime={entry.createdAt.toISOString()}>
                    {changelogDateText(entry.createdAt.toISOString())}
                  </time>
                </div>
                <p className="changelog-entry-meta">
                  <span>Environment: </span>
                  <strong>{entry.environment}</strong>
                </p>
                <p className="changelog-entry-meta">
                  <span>Commit: </span>
                  <Link
                    href={entry.commitUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="changelog-commit-link"
                  >
                    {entry.commit.slice(0, 7)}
                  </Link>
                </p>
                {renderLinks(entry.links)}
              </li>
            ))}
          </ol>
        </>
      )}
    </main>
  );
}
