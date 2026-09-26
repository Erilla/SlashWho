import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// `.node-version` and `packageManager` in package.json are the only places the
// Node and pnpm versions are written down. Everything else either reads them
// (setup-node's `node-version-file`, Corepack) or, where it cannot, is checked
// against them here.
const nodeVersion = readFileSync(".node-version", "utf8").trim();
const nodeMajor = nodeVersion.split(".")[0];

const dockerfiles = ["Dockerfile.web", "Dockerfile.worker"];

function workflowFiles(): string[] {
  const workflows = readdirSync(".github/workflows")
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(".github/workflows", name));
  const actions = readdirSync(".github/actions").map((name) =>
    join(".github/actions", name, "action.yml")
  );
  return [...workflows, ...actions];
}

describe("toolchain versions", () => {
  it("names an exact Node version in .node-version", () => {
    expect(nodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("builds every image on the Node version in .node-version", () => {
    for (const path of dockerfiles) {
      const bases = [
        ...readFileSync(path, "utf8").matchAll(/^FROM node:(\S+)/gm)
      ].map((match) => match[1]);

      expect(bases.length, path).toBeGreaterThan(0);
      for (const base of bases)
        expect(base, path).toBe(`${nodeVersion}-alpine`);
    }
  });

  it("leaves the pnpm version to packageManager in the images", () => {
    for (const path of dockerfiles) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/pnpm@/);
    }
  });

  it("leaves the Node and pnpm versions to their files in the workflows", () => {
    for (const path of workflowFiles()) {
      const text = readFileSync(path, "utf8");

      expect(text, path).not.toMatch(/^\s*node-version:/m);
      expect(text, path).not.toMatch(/uses:\s*pnpm\/action-setup/);
    }
  });

  it("types Node for the major version the images run", () => {
    const packages = ["package.json", "apps/web/package.json"];

    for (const path of packages) {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as {
        devDependencies?: Record<string, string>;
      };

      expect(manifest.devDependencies?.["@types/node"], path).toMatch(
        new RegExp(`^\\^?~?${nodeMajor}\\.`)
      );
    }
  });
});

// A tag can be moved to any commit by whoever controls the action's
// repository; a commit SHA cannot. Dependabot keeps the pins current and
// rewrites the version comment alongside each one.
describe("GitHub Actions", () => {
  it("pins every third-party action to a full commit SHA", () => {
    const offenders: string[] = [];

    for (const path of workflowFiles()) {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const match = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!match) continue;

        const [, reference, rest] = match;
        if (reference.startsWith("./")) continue;

        if (
          !/@[0-9a-f]{40}$/.test(reference) ||
          !/^\s+# v\d+\.\d+\.\d+$/.test(rest)
        ) {
          offenders.push(`${path}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
