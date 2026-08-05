import type { HistoryItem } from "@slashwho/contracts";
import Link from "next/link";

type RefreshHistoryProps = Readonly<{
  items: readonly HistoryItem[];
  selectedSnapshotId: string | null;
}>;

/**
 * Refresh times render in UTC with a visible zone label. A fixed zone keeps the
 * server-rendered text correct for every reader (rather than silently showing the
 * container's timezone as if it were theirs) and keeps hydration deterministic.
 */
export function formatRefreshTime(value: string): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(value));
  return `${formatted} UTC`;
}

function characterCount(count: number): string {
  return `${count} ${count === 1 ? "character" : "characters"}`;
}

export function RefreshHistory({
  items,
  selectedSnapshotId
}: RefreshHistoryProps) {
  return (
    <aside className="history-panel" aria-labelledby="history-heading">
      <h2 id="history-heading">Refresh history</h2>
      {items.length === 0 ? (
        <p className="empty-state">No completed refreshes yet.</p>
      ) : (
        <ol className="history-list">
          {items.map((item) => (
            <li className="history-row" key={item.id}>
              <Link
                className="history-link"
                href={`${item.characterUrl}/history/${item.id}`}
                aria-current={
                  selectedSnapshotId === item.id ? "page" : undefined
                }
              >
                <time dateTime={item.refreshedAt}>
                  {formatRefreshTime(item.refreshedAt)}
                </time>
                <span className="history-state" data-state={item.state}>
                  {item.state === "complete" ? "Complete" : "Partial"}
                </span>
                <span className="history-count">
                  {characterCount(item.characterCount)}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
