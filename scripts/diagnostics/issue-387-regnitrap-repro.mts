/**
 * Read-only, red-capable reproduction for GitHub issue #387.
 *
 * It follows the already-completed deployment job and fails while its resulting
 * dossier contains only the two reported characters. It never calls a refresh
 * or discovery-creating endpoint.
 *
 * Run: corepack pnpm tsx scripts/diagnostics/issue-387-regnitrap-repro.mts
 */

const origin = "https://web-test-7765.up.railway.app";
const jobId = "f56e76af-1405-43e0-bb7b-093a2411909d";
const dossierPath = "/api/dossiers/eu/draenor/regnitrap";

type Job = { status?: unknown; error?: unknown };
type Dossier = {
  characters?: Array<{ key?: { name?: unknown } }>;
  research?: { state?: unknown; message?: unknown };
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`GET ${path} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

const [job, dossier] = await Promise.all([
  getJson<Job>(`/api/dossiers/jobs/${jobId}`),
  getJson<Dossier>(dossierPath)
]);

const names = dossier.characters
  ?.map((character) => character.key?.name)
  .join(", ");
console.log(
  JSON.stringify({
    jobStatus: job.status,
    jobError: job.error,
    characterCount: dossier.characters?.length,
    characters: names,
    researchState: dossier.research?.state,
    researchMessage: dossier.research?.message
  })
);

if (job.status !== "complete") {
  throw new Error(
    `Expected the linked job to be complete; received ${String(job.status)}`
  );
}

if (dossier.characters?.length === 2) {
  throw new Error(
    `ISSUE-387 REPRODUCED: expected discovery to reach more than two characters; received ${names}`
  );
}

if ((dossier.characters?.length ?? 0) < 2) {
  throw new Error(
    `Expected the reported two-character outcome; received ${names ?? "none"}`
  );
}

console.log("Issue #387's two-character symptom is absent.");
