import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { webBuildFreshness } from "./web-build";

describe("webBuildFreshness", () => {
  let root: string;
  const built = new Date("2026-09-01T12:00:00Z");
  const before = new Date("2026-09-01T11:00:00Z");
  const after = new Date("2026-09-01T13:00:00Z");

  const age = (path: string, at: Date) => utimesSync(join(root, path), at, at);
  const touch = (path: string, at: Date) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "");
    age(path, at);
  };
  // Creating a file dates its directories; settle them before the build so
  // each case moves exactly one input past it.
  const ageDirectories = (...paths: string[]) => {
    for (const path of [
      "apps/web/src/app",
      "apps/web/src",
      "apps/web",
      "apps",
      "packages/domain/src",
      "packages/domain",
      "packages",
      ...paths
    ])
      age(path, before);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "slashwho-web-build-"));
    touch("package.json", before);
    touch("pnpm-lock.yaml", before);
    touch("tsconfig.base.json", before);
    touch("apps/web/next.config.ts", before);
    touch("apps/web/src/app/page.tsx", before);
    touch("packages/domain/src/index.ts", before);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a missing build when no build ID exists", () => {
    ageDirectories();
    expect(webBuildFreshness(root)).toBe("missing");
  });

  it("accepts a build newer than every input", () => {
    touch("apps/web/.next/BUILD_ID", built);
    ageDirectories();
    expect(webBuildFreshness(root)).toBe("fresh");
  });

  it("rejects a build older than an edited web source", () => {
    // Break caught: testing yesterday's bundle while reporting today's code
    // as passing.
    touch("apps/web/.next/BUILD_ID", built);
    ageDirectories();
    age("apps/web/src/app/page.tsx", after);
    expect(webBuildFreshness(root)).toBe("stale");
  });

  it("rejects a build older than an edited workspace package", () => {
    // The web app transpiles workspace packages from source, so their edits
    // change the bundle as much as the app's own.
    touch("apps/web/.next/BUILD_ID", built);
    ageDirectories();
    age("packages/domain/src/index.ts", after);
    expect(webBuildFreshness(root)).toBe("stale");
  });

  it("rejects a build older than a deleted source file", () => {
    // A deletion leaves no file to date; only its directory records it.
    touch("apps/web/.next/BUILD_ID", built);
    ageDirectories();
    age("apps/web/src/app", after);
    expect(webBuildFreshness(root)).toBe("stale");
  });

  it("rejects a build older than the lockfile", () => {
    touch("apps/web/.next/BUILD_ID", built);
    ageDirectories();
    age("pnpm-lock.yaml", after);
    expect(webBuildFreshness(root)).toBe("stale");
  });

  it("ignores build output and installed dependencies", () => {
    touch("apps/web/.next/BUILD_ID", built);
    touch("apps/web/.next/server/app/page.js", after);
    touch("apps/web/node_modules/next/index.js", after);
    touch("packages/domain/node_modules/zod/index.js", after);
    ageDirectories("apps/web/.next", "apps/web/node_modules");
    expect(webBuildFreshness(root)).toBe("fresh");
  });
});
