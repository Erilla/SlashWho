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

  useEffect(() => {
    const update = () => setRemaining(target - Date.now());
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [target]);

  if (!Number.isFinite(target) || remaining <= 0) {
    return null;
  }

  const provider =
    source === "warcraft_logs"
      ? "Warcraft Logs"
      : source === "raiderio"
        ? "Raider.IO"
        : "Blizzard";

  return (
    <p className="dossier-rate-limit-countdown" role="status">
      {provider} limit resets in {formatRemaining(remaining)}
    </p>
  );
}
