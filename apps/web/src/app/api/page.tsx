import type { Metadata } from "next";

export const metadata: Metadata = { title: "API v1" };

export default function ApiPage() {
  return (
    <main className="document-page">
      <h1>API v1</h1>
      <p>
        All endpoints return JSON under <code>/api/v1</code>. Website clients
        may call public endpoints anonymously. The bot sends its configured
        token as <code>Authorization: Bearer &lt;token&gt;</code>; the token
        itself must never be included in URLs or committed files.
      </p>

      <h2>Endpoints</h2>
      <ul className="endpoint-list">
        <li>
          <code>POST /api/v1/searches</code> — create or reuse a character
          search.
        </li>
        <li>
          <code>GET /api/v1/searches/{`{jobId}`}</code> — poll a discovery job.
        </li>
        <li>
          <code>
            GET /api/v1/characters/{`{region}`}/{`{realm}`}/{`{name}`}
          </code>{" "}
          — read the current snapshot.
        </li>
        <li>
          <code>
            GET /api/v1/characters/{`{region}`}/{`{realm}`}/{`{name}`}/history
          </code>{" "}
          — list refresh history.
        </li>
        <li>
          <code>
            GET /api/v1/characters/{`{region}`}/{`{realm}`}/{`{name}`}/history/
            {`{snapshotId}`}
          </code>{" "}
          — read an immutable refresh.
        </li>
      </ul>

      <h2>Polling</h2>
      <p>
        A new search may return <code>202</code> with a status URL. Poll that
        URL while the status is <code>queued</code>, <code>running</code>, or{" "}
        <code>retrying</code>, using bounded backoff. Stop on{" "}
        <code>complete</code> or <code>failed</code>. Respect{" "}
        <code>Retry-After</code> on any <code>429</code> response.
      </p>

      <h2>States and safe errors</h2>
      <p>
        Snapshot state is <code>complete</code> or <code>partial</code>. Job
        status is <code>queued</code>, <code>running</code>,{" "}
        <code>retrying</code>, <code>complete</code>, or <code>failed</code>.
        Public errors use stable codes: <code>invalid_character_url</code>,{" "}
        <code>character_not_found</code>, <code>rate_limited</code>,{" "}
        <code>upstream_unavailable</code>, <code>search_failed</code>,{" "}
        <code>suppressed_character</code>, <code>unauthorized</code>, and{" "}
        <code>trusted_client_ip_unavailable</code>.
      </p>

      <p>
        The checked-in{" "}
        <a href="https://github.com/Erilla/SlashWho/blob/main/tests/fixtures/contracts/bot-client-v1.json">
          bot compatibility fixture
        </a>{" "}
        is the reference payload for client integration.
      </p>
    </main>
  );
}
