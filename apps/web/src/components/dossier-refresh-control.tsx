"use client";

import { useEffect, useState } from "react";

type RefreshOutcome = Readonly<{ mode: "full" | "light" }>;

function formatAge(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * Re-collects this character on demand and says how stale its evidence is.
 *
 * The cooldown is not shown. A press inside it reads only the most recent
 * reports, which is reported as a different outcome rather than refused — the
 * reader gets something useful either way, and the wording does not claim more
 * work happened than did.
 */
export function DossierRefreshControl({
  lastCollectedAt,
  onRefresh,
  busy = false,
  now = () => new Date()
}: Readonly<{
  lastCollectedAt: string | null;
  onRefresh: () => Promise<RefreshOutcome>;
  /**
   * Whether a collection is already running for this dossier. Pressing during
   * one would reserve nothing — an in-flight run is joined, not duplicated —
   * so the press would look like the button not working.
   */
  busy?: boolean;
  now?: () => Date;
}>) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<RefreshOutcome["mode"] | null>(null);
  // Re-render so the age keeps pace without the reader reloading.
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => setTick((v) => v + 1), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const collected = lastCollectedAt ? Date.parse(lastCollectedAt) : Number.NaN;
  const age = Number.isFinite(collected)
    ? formatAge(now().getTime() - collected)
    : null;

  return (
    <div className="dossier-refresh">
      <button
        className="dossier-refresh-button"
        disabled={pending || busy}
        onClick={() => {
          if (pending || busy) return;
          setPending(true);
          setOutcome(null);
          void onRefresh()
            .then((result) => setOutcome(result.mode))
            .finally(() => setPending(false));
        }}
        type="button"
      >
        {pending ? "Refreshing…" : "Refresh"}
      </button>
      {/* A live region only while it has an outcome to announce: the resting
          state is static text, not something a screen reader should interrupt
          for. */}
      <p
        className="dossier-refresh-age"
        role={outcome || busy ? "status" : undefined}
      >
        {busy
          ? "Collecting…"
          : outcome === "light"
            ? "Checked for new kills"
            : outcome === "full"
              ? "Re-collecting evidence"
              : (age ?? "Not collected yet")}
      </p>
    </div>
  );
}
