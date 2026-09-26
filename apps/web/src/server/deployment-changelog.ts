type ChangeLogEnvironment = Readonly<{
  id: number;
  createdAt: Date;
  environment: string;
  commit: string;
  summary: string;
  links: readonly {
    number: number;
    href: string;
    label: string;
  }[];
  commitUrl: string;
}>;

type ChangeLogUnavailable = Readonly<{
  kind: "unavailable";
  generatedAt: Date;
  reason: string;
}>;

export type ChangelogResult = Readonly<
  | {
      kind: "available";
      source: "github_deployments";
      repository: string;
      generatedAt: Date;
      entries: readonly ChangeLogEnvironment[];
    }
  | ChangeLogUnavailable
>;

type ChangelogLoadOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  repository?: string;
  environments?: readonly string[];
  maxEntries?: number;
  fetch?: typeof globalThis.fetch;
  githubToken?: string;
  maxDeploymentsPerEnvironment?: number;
}>;

type GithubDeployment = Readonly<{
  id: number;
  environment: string | null;
  sha: string;
  created_at: string;
  statuses_url: string;
  description?: string | null;
}>;

type GithubDeploymentStatus = Readonly<{
  state: string;
  created_at: string | null;
}>;

type GithubCommit = Readonly<{
  sha: string;
  commit: {
    message: string;
  };
}>;

const githubApiBase = "https://api.github.com";
const defaultMaxEntries = 20;
const defaultDeploymentsPerEnvironment = 40;
// Parallel GitHub reads per batch: enough to collapse ~40 serial round trips
// into a handful, without bursting a whole page of requests at once.
const githubReadConcurrency = 8;

function parseList(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

function parseInteger(
  value: number | undefined,
  fallback: number,
  min: number
): number {
  if (value === undefined || Number.isNaN(value) || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(min, value);
}

function parseDate(input: string | null, fallback: number): Date {
  const date = new Date(input ?? "");
  return Number.isNaN(date.valueOf()) ? new Date(fallback) : date;
}

function normalizeReferences(text: string): string[] {
  const matchSet = new Set<string>();
  for (const match of text.matchAll(/#(\d+)/g)) {
    matchSet.add(match[1]);
  }
  return [...matchSet];
}

function buildSummary(message: string): string {
  const [firstLine] = message.split("\n");
  const trimmed = firstLine.trim();
  if (trimmed.length > 0) return trimmed;
  return "Deployment";
}

function safeLink(repository: string, issueNumber: string): string {
  return `https://github.com/${repository}/issues/${issueNumber}`;
}

function parseChangelogOptions(input: ChangelogLoadOptions): {
  repository: string;
  environments: readonly string[];
  maxEntries: number;
  maxDeploymentsPerEnvironment: number;
  fetch: typeof globalThis.fetch;
  githubToken?: string;
} {
  const source = input.environment ?? process.env;
  const repository = (
    input.repository ??
    source.SLASHWHO_CHANGELOG_REPOSITORY ??
    source.GITHUB_REPOSITORY ??
    ""
  ).trim();
  if (!repository) {
    throw new Error("changelog_repository_missing");
  }

  const environments = (
    input.environments?.length
      ? input.environments
      : parseList(source.SLASHWHO_CHANGELOG_ENVIRONMENTS)
  ).map((environment) => environment.toLowerCase());
  const normalized = environments.length > 0 ? environments : ["production"];

  const maxEntries = parseInteger(
    input.maxEntries ?? Number(source.SLASHWHO_CHANGELOG_MAX_ENTRIES),
    defaultMaxEntries,
    1
  );
  const maxDeploymentsPerEnvironment = parseInteger(
    input.maxDeploymentsPerEnvironment ??
      Number(source.SLASHWHO_CHANGELOG_MAX_DEPLOYMENTS_PER_ENVIRONMENT),
    defaultDeploymentsPerEnvironment,
    1
  );

  return {
    repository,
    environments: normalized,
    maxEntries,
    maxDeploymentsPerEnvironment,
    fetch: input.fetch ?? globalThis.fetch,
    githubToken:
      input.githubToken ?? source.SLASHWHO_GITHUB_TOKEN ?? source.GITHUB_TOKEN
  };
}

function createHeaders(token: string | undefined): HeadersInit {
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "user-agent": "SlashWho deployment changelog"
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function fetchJson<T>(
  fetchInstance: typeof globalThis.fetch,
  input: string,
  headers: HeadersInit
): Promise<T> {
  const response = await fetchInstance(input, { headers });
  if (!response.ok) {
    throw new Error(`fetch_failed:${response.status}`);
  }
  return (await response.json()) as T;
}

async function readDeploymentStatus(
  fetchInstance: typeof globalThis.fetch,
  statusUrl: string,
  headers: HeadersInit
): Promise<GithubDeploymentStatus | null> {
  const statuses = await fetchJson<GithubDeploymentStatus[]>(
    fetchInstance,
    `${statusUrl}?per_page=100`,
    headers
  );
  if (!Array.isArray(statuses)) return null;
  return statuses.find((status) => status?.state === "success") ?? null;
}

async function readDeploymentCommitMessage(
  fetchInstance: typeof globalThis.fetch,
  repository: string,
  sha: string,
  headers: HeadersInit
): Promise<string | null> {
  const commit = await fetchJson<GithubCommit>(
    fetchInstance,
    `${githubApiBase}/repos/${repository}/commits/${sha}`,
    headers
  );
  return commit.commit?.message ?? null;
}

async function readStatusOrNull(
  fetchInstance: typeof globalThis.fetch,
  statusUrl: string,
  headers: HeadersInit
): Promise<GithubDeploymentStatus | null> {
  try {
    return await readDeploymentStatus(fetchInstance, statusUrl, headers);
  } catch {
    return null;
  }
}

async function readCommitMessageOrNull(
  fetchInstance: typeof globalThis.fetch,
  repository: string,
  sha: string,
  headers: HeadersInit
): Promise<string | null> {
  try {
    return await readDeploymentCommitMessage(
      fetchInstance,
      repository,
      sha,
      headers
    );
  } catch {
    // Commit enrichment is optional; retain the deployment with a fallback summary.
    return null;
  }
}

type SelectedDeployment = Readonly<{
  deployment: GithubDeployment;
  status: GithubDeploymentStatus;
}>;

async function loadForEnvironment(
  repository: string,
  environment: string,
  maxEntries: number,
  maxDeploymentsPerEnvironment: number,
  fetchInstance: typeof globalThis.fetch,
  headers: HeadersInit
): Promise<readonly ChangeLogEnvironment[]> {
  const selected = new Map<string, SelectedDeployment>();
  const pageSize = Math.min(100, maxDeploymentsPerEnvironment);
  for (let page = 1; ; page += 1) {
    const deployments = await fetchJson<GithubDeployment[]>(
      fetchInstance,
      `${githubApiBase}/repos/${repository}/deployments?environment=${encodeURIComponent(environment)}&per_page=${pageSize}&page=${page}`,
      headers
    );
    if (!Array.isArray(deployments)) break;

    const candidates = [...deployments]
      .sort(compareDeployments)
      .filter((deployment) => deployment?.sha && deployment.statuses_url);
    // Statuses are read a batch at a time, newest first, so selection stays in
    // order and stops within one batch of the cap instead of reading the page.
    for (
      let offset = 0;
      offset < candidates.length && selected.size < maxEntries;
      offset += githubReadConcurrency
    ) {
      const batch = candidates.slice(offset, offset + githubReadConcurrency);
      const statuses = await Promise.all(
        batch.map((deployment) =>
          readStatusOrNull(fetchInstance, deployment.statuses_url, headers)
        )
      );
      batch.forEach((deployment, index) => {
        const status = statuses[index];
        if (!status || selected.size >= maxEntries) return;
        if (selected.has(deployment.sha)) return;
        selected.set(deployment.sha, { deployment, status });
      });
    }

    if (selected.size >= maxEntries || deployments.length < pageSize) break;
  }

  const chosen = [...selected.values()];
  const messages: (string | null)[] = [];
  for (
    let offset = 0;
    offset < chosen.length;
    offset += githubReadConcurrency
  ) {
    const batch = chosen.slice(offset, offset + githubReadConcurrency);
    messages.push(
      ...(await Promise.all(
        batch.map(({ deployment }) =>
          readCommitMessageOrNull(
            fetchInstance,
            repository,
            deployment.sha,
            headers
          )
        )
      ))
    );
  }

  return chosen
    .map(({ deployment, status }, index) =>
      toEntry(repository, environment, deployment, status, messages[index])
    )
    .sort(compareEntries);
}

function toEntry(
  repository: string,
  environment: string,
  deployment: GithubDeployment,
  status: GithubDeploymentStatus,
  commitMessage: string | null
): ChangeLogEnvironment {
  const commitSha = deployment.sha;
  const summary = commitMessage
    ? buildSummary(commitMessage)
    : `Deploy ${environment}`;
  const links = commitMessage
    ? normalizeReferences(commitMessage)
        .slice(0, 4)
        .map((number) => ({
          number: Number(number),
          href: safeLink(repository, number),
          label: `#${number}`
        }))
    : [];
  const deployedAt = parseDate(
    status.created_at,
    parseDate(deployment.created_at, 0).valueOf()
  );
  return {
    id: deployment.id,
    createdAt: deployedAt,
    environment,
    commit: commitSha,
    summary,
    links,
    commitUrl: `https://github.com/${repository}/commit/${commitSha}`
  };
}

function compareDeployments(
  left: GithubDeployment,
  right: GithubDeployment
): number {
  const byCreated =
    new Date(right.created_at).valueOf() - new Date(left.created_at).valueOf();
  return byCreated || right.id - left.id;
}

function compareEntries(
  left: ChangeLogEnvironment,
  right: ChangeLogEnvironment
): number {
  const byCreated = right.createdAt.valueOf() - left.createdAt.valueOf();
  return byCreated || right.id - left.id;
}

export async function loadDeploymentChangelog(
  options: ChangelogLoadOptions = {}
): Promise<ChangelogResult> {
  const startedAt = Date.now();
  try {
    const {
      repository,
      environments,
      maxEntries,
      maxDeploymentsPerEnvironment,
      fetch: fetchInstance,
      githubToken
    } = parseChangelogOptions(options);

    const headers = createHeaders(githubToken);
    const entries = new Map<string, ChangeLogEnvironment>();

    for (const environmentName of environments) {
      const byEnvironment = await loadForEnvironment(
        repository,
        environmentName,
        Math.max(1, maxEntries - entries.size),
        maxDeploymentsPerEnvironment,
        fetchInstance,
        headers
      );
      for (const entry of byEnvironment) {
        if (entries.has(entry.commit)) continue;
        entries.set(entry.commit, entry);
        if (entries.size >= maxEntries) break;
      }
      if (entries.size >= maxEntries) break;
    }

    const ordered = [...entries.values()].sort(compareEntries);

    return {
      kind: "available",
      source: "github_deployments",
      repository,
      generatedAt: new Date(startedAt),
      entries: ordered
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "changelog_repository_missing"
    ) {
      return {
        kind: "unavailable",
        generatedAt: new Date(startedAt),
        reason:
          "Set SLASHWHO_CHANGELOG_REPOSITORY or GITHUB_REPOSITORY to enable changelog entries."
      };
    }
    return {
      kind: "unavailable",
      generatedAt: new Date(startedAt),
      reason: "Deployment changelog metadata is unavailable right now."
    };
  }
}

type ChangelogCacheOptions = Readonly<{
  ttlMs: number;
  unavailableTtlMs: number;
  now?: () => number;
}>;

/**
 * Wraps a changelog loader so repeated page views reuse one result for the TTL
 * and concurrent views share a single in-flight load. An unavailable result is
 * kept only briefly, so a GitHub outage recovers quickly without every view
 * retrying it.
 */
export function createChangelogCache(
  load: () => Promise<ChangelogResult>,
  { ttlMs, unavailableTtlMs, now = Date.now }: ChangelogCacheOptions
): () => Promise<ChangelogResult> {
  let pending: Promise<ChangelogResult> | null = null;
  let expiresAt = 0;
  return () => {
    if (pending && now() < expiresAt) return pending;
    const current = load().then(
      (result) => {
        if (pending === current) {
          expiresAt =
            now() + (result.kind === "available" ? ttlMs : unavailableTtlMs);
        }
        return result;
      },
      (error: unknown) => {
        if (pending === current) pending = null;
        throw error;
      }
    );
    pending = current;
    expiresAt = Number.POSITIVE_INFINITY;
    return current;
  };
}

export const loadCachedDeploymentChangelog = createChangelogCache(
  () => loadDeploymentChangelog(),
  { ttlMs: 5 * 60_000, unavailableTtlMs: 30_000 }
);
