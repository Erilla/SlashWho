import Link from "next/link";

import {
  loadCachedDeploymentChangelog,
  type ChangelogResult
} from "../../server/deployment-changelog";

// Rendered per request so runtime configuration is read; the GitHub data behind
// it is cached in-process by loadCachedDeploymentChangelog.
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
  const changelog: ChangelogResult = await loadCachedDeploymentChangelog();
  // Every entry naming the same environment is noise; show it only when the
  // list mixes environments.
  const showEnvironment =
    changelog.kind === "available" &&
    new Set(changelog.entries.map((entry) => entry.environment)).size > 1;

  return (
    <main className="page-shell document-page changelog-page">
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
                <p className="changelog-entry-summary">{entry.summary}</p>
                <div className="changelog-entry-meta">
                  <time dateTime={entry.createdAt.toISOString()}>
                    {changelogDateText(entry.createdAt.toISOString())}
                  </time>
                  <Link
                    href={entry.commitUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="changelog-commit-link"
                    aria-label={`Commit ${entry.commit.slice(0, 7)}`}
                  >
                    {entry.commit.slice(0, 7)}
                  </Link>
                  {showEnvironment ? (
                    <span className="changelog-entry-environment">
                      {entry.environment}
                    </span>
                  ) : null}
                  {renderLinks(entry.links)}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </main>
  );
}
