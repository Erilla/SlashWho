import { afterEach, expect, it, vi } from "vitest";

import { loadDeploymentChangelog } from "./deployment-changelog";

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
