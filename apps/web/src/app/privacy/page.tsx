import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <main className="document-page">
      <h1>Privacy</h1>
      <p>
        This service reads public World of Warcraft character information and
        public character relationships from Raider.IO. It stores character
        names, regions, realms, classes, levels, Raider.IO links, and the
        character membership observed during each refresh.
      </p>

      <h2>Refresh retention</h2>
      <p>
        Completed and partial refresh snapshots are retained permanently so that
        a result can be revisited at its exact refresh date and time. Historical
        snapshots are immutable.
      </p>

      <h2>What is never stored</h2>
      <p>
        BattleTags, Discord handles, private credentials, raw Raider.IO
        responses, and internal validation guesses are never stored or shown.
      </p>

      <h2>Removal requests</h2>
      <p>
        Removal requests are manually verified. Submit a request using the{" "}
        <a href="https://github.com/Erilla/SlashWho/issues/new?template=removal-request.yml">
          repository removal-request form
        </a>
        . Accepted requests remove the character from public results and
        suppress it from future discovery.
      </p>
    </main>
  );
}
