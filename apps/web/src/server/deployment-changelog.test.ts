import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createChangelogCache,
  loadDeploymentChangelog,
  type ChangelogResult
} from "./deployment-changelog";

function jsonResponse(value: object, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("loads successful deployment entries and resolves references", async () => {
  const fetch = vi.fn(async (value: RequestInfo | URL) => {
    const url = String(value);
    if (url.includes("/deployments?environment=production")) {
      return jsonResponse([
        {
          id: 31,
          environment: "production",
          sha: "abc1234",
          created_at: "2026-09-14T09:10:00Z",
          statuses_url:
            "https://api.github.com/repos/acme/repo/deployments/31/statuses"
        }
      ]);
    }
    if (
      url.startsWith(
        "https://api.github.com/repos/acme/repo/deployments/31/statuses"
      )
    ) {
      return jsonResponse([
        { state: "success", created_at: "2026-09-14T09:15:00Z" }
      ]);
    }
    if (url.endsWith("/commits/abc1234")) {
      return jsonResponse({
        sha: "abc1234",
        commit: { message: "Ship deployment changelog entries (#45) and docs." }
      });
    }
    return jsonResponse({}, 404);
  });

  const changelog = await loadDeploymentChangelog({
    repository: "acme/repo",
    environments: ["production"],
    maxEntries: 5,
    maxDeploymentsPerEnvironment: 5,
    fetch
  });

  expect(changelog.kind).toBe("available");
  if (changelog.kind === "unavailable") throw new Error("unreachable");
  expect(changelog.entries).toHaveLength(1);
  expect(changelog.entries[0]).toMatchObject({
    environment: "production",
    commit: "abc1234",
    summary: "Ship deployment changelog entries (#45) and docs.",
    links: [{ number: 45, label: "#45" }]
  });
});

it("ignores failed deployment statuses", async () => {
  const fetch = vi.fn(async (value: RequestInfo | URL) => {
    const url = String(value);
    if (url.includes("/deployments?environment=production")) {
      return jsonResponse([
        {
          id: 44,
          environment: "production",
          sha: "bad111",
          created_at: "2026-09-14T09:10:00Z",
          statuses_url:
            "https://api.github.com/repos/acme/repo/deployments/44/statuses"
        }
      ]);
    }
    if (
      url.startsWith(
        "https://api.github.com/repos/acme/repo/deployments/44/statuses"
      )
    ) {
      return jsonResponse([
        { state: "failed", created_at: "2026-09-14T09:11:00Z" }
      ]);
    }
    return jsonResponse({}, 404);
  });

  const changelog = await loadDeploymentChangelog({
    repository: "acme/repo",
    environments: ["production"],
    fetch
  });

  expect(changelog.kind).toBe("available");
  if (changelog.kind === "unavailable") throw new Error("unreachable");
  expect(changelog.entries).toHaveLength(0);
});

it("includes deployments with a success before a later inactive status", async () => {
  const fetch = vi.fn(async (value: RequestInfo | URL) => {
    const url = String(value);
    if (url.includes("/deployments?environment=production")) {
      return jsonResponse([
        {
          id: 45,
          sha: "new456",
          created_at: "2026-09-14T10:00:00Z",
          statuses_url:
            "https://api.github.com/repos/acme/repo/deployments/45/statuses"
        },
        {
          id: 46,
          sha: "old123",
          created_at: "2026-09-14T09:00:00Z",
          statuses_url:
            "https://api.github.com/repos/acme/repo/deployments/46/statuses"
        }
      ]);
    }
    if (url.endsWith("/deployments/45/statuses?per_page=100"))
      return jsonResponse([
        { state: "success", created_at: "2026-09-14T10:01:00Z" }
      ]);
    if (url.endsWith("/deployments/46/statuses?per_page=100"))
      return jsonResponse([
        { state: "inactive", created_at: "2026-09-14T09:02:00Z" },
        { state: "success", created_at: "2026-09-14T09:01:00Z" }
      ]);
    return jsonResponse({ commit: { message: "Deployment" } });
  });
  const changelog = await loadDeploymentChangelog({
    repository: "acme/repo",
    environments: ["production"],
    fetch
  });
  expect(changelog.kind).toBe("available");
  if (changelog.kind === "unavailable") throw new Error("unreachable");
  expect(changelog.entries.map((entry) => entry.commit)).toEqual([
    "new456",
    "old123"
  ]);
});

it("keeps empty and partial upstream responses available", async () => {
  const fetch = vi.fn(async (value: RequestInfo | URL) => {
    const url = String(value);
    return url.includes("/deployments?environment=production")
      ? jsonResponse([
          { id: 50, sha: "", created_at: "invalid", statuses_url: "" }
        ])
      : jsonResponse({}, 404);
  });
  const changelog = await loadDeploymentChangelog({
    repository: "acme/repo",
    environments: ["production"],
    fetch
  });
  expect(changelog).toMatchObject({ kind: "available", entries: [] });
});

it("paginates deployment history when a page is full", async () => {
  const fetch = vi.fn(async (value: RequestInfo | URL) => {
    const url = String(value);
    const page = url.match(/[?&]page=(\d+)/)?.[1];
    if (page === "1" || page === "2") {
      const id = page === "1" ? 61 : 62;
      return jsonResponse([
        {
          id,
          sha: `commit${page}`,
          created_at: `2026-09-14T0${page}:00:00Z`,
          statuses_url: `https://api.github.com/repos/acme/repo/deployments/${id}/statuses`
        }
      ]);
    }
    if (page === "3") return jsonResponse([]);
    if (url.includes("/statuses?per_page=100"))
      return jsonResponse([
        { state: "success", created_at: "2026-09-14T10:01:00Z" }
      ]);
    return jsonResponse({ commit: { message: "Deployment" } });
  });
  const changelog = await loadDeploymentChangelog({
    repository: "acme/repo",
    environments: ["production"],
    maxEntries: 2,
    maxDeploymentsPerEnvironment: 1,
    fetch
  });
  expect(changelog.kind).toBe("available");
  if (changelog.kind === "unavailable") throw new Error("unreachable");
  expect(changelog.entries.map((entry) => entry.commit)).toEqual([
    "commit2",
    "commit1"
  ]);
});

it("returns unavailable if repository is not configured", async () => {
  const changelog = await loadDeploymentChangelog({ environment: {} });
  expect(changelog.kind).toBe("unavailable");
});

function deploymentFixture(id: number, sha: string, minute: number) {
  return {
    id,
    sha,
    created_at: `2026-09-14T10:${String(minute).padStart(2, "0")}:00Z`,
    statuses_url: `https://api.github.com/repos/acme/repo/deployments/${id}/statuses`
  };
}

it("reads deployment statuses and commits concurrently", async () => {
  let inFlight = 0;
  let maxStatusesInFlight = 0;
  let maxCommitsInFlight = 0;
  const fetch = vi.fn(async (value: RequestInfo | URL) => {
    const url = String(value);
    if (url.includes("/deployments?environment=production")) {
      return jsonResponse(
        [1, 2, 3, 4, 5, 6].map((id) =>
          deploymentFixture(id, `sha${id}`, 60 - id)
        )
      );
    }
    const isStatus = url.includes("/statuses");
    inFlight += 1;
    if (isStatus) maxStatusesInFlight = Math.max(maxStatusesInFlight, inFlight);
    else maxCommitsInFlight = Math.max(maxCommitsInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return isStatus
      ? jsonResponse([{ state: "success", created_at: "2026-09-14T11:00:00Z" }])
      : jsonResponse({ commit: { message: "Deployment" } });
  });

  const changelog = await loadDeploymentChangelog({
    repository: "acme/repo",
    environments: ["production"],
    fetch
  });

  expect(changelog).toMatchObject({ kind: "available" });
  if (changelog.kind === "unavailable") throw new Error("unreachable");
  expect(changelog.entries).toHaveLength(6);
  expect(maxStatusesInFlight).toBeGreaterThan(1);
  expect(maxCommitsInFlight).toBeGreaterThan(1);
});

it("keeps newest-first selection and only enriches selected entries", async () => {
  const fetch = vi.fn(async (value: RequestInfo | URL) => {
    const url = String(value);
    if (url.includes("/deployments?environment=production")) {
      return jsonResponse([
        deploymentFixture(4, "shaD", 10),
        deploymentFixture(1, "shaA", 40),
        deploymentFixture(3, "shaB", 20),
        deploymentFixture(2, "shaB", 30),
        deploymentFixture(5, "shaE", 5)
      ]);
    }
    if (url.includes("/deployments/1/statuses"))
      return jsonResponse([{ state: "failure", created_at: null }]);
    if (url.includes("/statuses"))
      return jsonResponse([{ state: "success", created_at: null }]);
    const sha = url.split("/commits/")[1];
    return jsonResponse({ commit: { message: `Ship ${sha}` } });
  });

  const changelog = await loadDeploymentChangelog({
    repository: "acme/repo",
    environments: ["production"],
    maxEntries: 2,
    fetch
  });

  expect(changelog.kind).toBe("available");
  if (changelog.kind === "unavailable") throw new Error("unreachable");
  expect(
    changelog.entries.map((entry) => [entry.id, entry.commit, entry.summary])
  ).toEqual([
    [2, "shaB", "Ship shaB"],
    [4, "shaD", "Ship shaD"]
  ]);
  const commitReads = fetch.mock.calls
    .map(([value]) => String(value))
    .filter((url) => url.includes("/commits/"));
  expect(commitReads.sort()).toEqual([
    "https://api.github.com/repos/acme/repo/commits/shaB",
    "https://api.github.com/repos/acme/repo/commits/shaD"
  ]);
});

describe("createChangelogCache", () => {
  const available = {
    kind: "available",
    source: "github_deployments",
    repository: "acme/repo",
    generatedAt: new Date(0),
    entries: []
  } as const;
  const unavailable = {
    kind: "unavailable",
    generatedAt: new Date(0),
    reason: "down"
  } as const;

  it("serves a loaded changelog until the TTL expires", async () => {
    let now = 0;
    const load = vi.fn(async () => available);
    const cached = createChangelogCache(load, {
      ttlMs: 1_000,
      unavailableTtlMs: 100,
      now: () => now
    });

    await cached();
    now = 999;
    await cached();
    expect(load).toHaveBeenCalledTimes(1);
    now = 1_000;
    await cached();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    const load = vi.fn(async () => available);
    const cached = createChangelogCache(load, {
      ttlMs: 1_000,
      unavailableTtlMs: 100,
      now: () => 0
    });

    const results = await Promise.all([cached(), cached(), cached()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result === available)).toBe(true);
  });

  it("holds an unavailable changelog only for the shorter TTL", async () => {
    let now = 0;
    const load = vi
      .fn<() => Promise<ChangelogResult>>()
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValue(available);
    const cached = createChangelogCache(load, {
      ttlMs: 1_000,
      unavailableTtlMs: 100,
      now: () => now
    });

    expect(await cached()).toBe(unavailable);
    now = 99;
    expect(await cached()).toBe(unavailable);
    now = 100;
    expect(await cached()).toBe(available);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retries after a load that rejects", async () => {
    const load = vi
      .fn<() => Promise<ChangelogResult>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(available);
    const cached = createChangelogCache(load, {
      ttlMs: 1_000,
      unavailableTtlMs: 100,
      now: () => 0
    });

    await expect(cached()).rejects.toThrow("boom");
    expect(await cached()).toBe(available);
  });
});
