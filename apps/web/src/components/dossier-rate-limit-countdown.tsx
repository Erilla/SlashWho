"use client";

import { useEffect, useState } from "react";

function formatRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;

  if (minutes > 0 && remainder > 0) return `${minutes}m ${remainder}s`;
  if (minutes > 0) return `${minutes}m`;
  return `${remainder}s`;
}

export function DossierRateLimitCountdown({
  retryAt,
  source
}: Readonly<{
  retryAt: string;
  source: "raiderio" | "warcraft_logs" | "blizzard";
}>) {
  const target = Date.parse(retryAt);
  const [remaining, setRemaining] = useState(() => target - Date.now());
  const running = Number.isFinite(target) && remaining > 0;
  // A limit that had already reset when the page loaded says nothing at all;
  // one seen running is announced when it finishes.
  const [seenRunning, setSeenRunning] = useState(running);
  if (running && !seenRunning) setSeenRunning(true);

  useEffect(() => {
    const update = () => setRemaining(target - Date.now());
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [target]);

  const provider =
    source === "warcraft_logs"
      ? "Warcraft Logs"
      : source === "raiderio"
        ? "Raider.IO"
        : "Blizzard";

  // Empty on mount and filled once the region is in place: a live region reads
  // changes, not what it held when it appeared. The ticking text stays outside
  // it, so a screen reader hears the start and the finish, not every second.
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!seenRunning) return;
    setAnnouncement(
      running
        ? `${provider} limit reached. It resets in ${formatRemaining(target - Date.now())}.`
        : `${provider} limit has reset.`
    );
  }, [provider, running, seenRunning, target]);

  if (!seenRunning) return null;

  return (
    <>
      {running ? (
        <p className="dossier-rate-limit-countdown">
          {provider} limit resets in {formatRemaining(remaining)}
        </p>
      ) : null}
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
    </>
  );
}
