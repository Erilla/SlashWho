"use client";

import { earlyDossierReadScript } from "../lib/early-dossier-read";

/**
 * Starts a dossier's first read from the server HTML, before hydration. The
 * script runs only on a full page load: rendered on the client, after a
 * client navigation, it is `text/plain` and the page's own read goes out.
 */
export function EarlyDossierReadScript({ path }: Readonly<{ path: string }>) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: earlyDossierReadScript(path) }}
    />
  );
}
