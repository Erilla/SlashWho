import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { describe, expect, it } from "vitest";

// A literal NUL byte makes grep and ripgrep classify the whole file as binary,
// hiding it from code search and from some diff and review tools. Write the
// `\u0000` escape instead; the runtime string is the same.
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
]);

function trackedTextFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((path) => textExtensions.has(extname(path)));
}

describe("tracked source files", () => {
  it("contain no literal NUL bytes", () => {
    const files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((path) => readFileSync(path).includes(0));

    expect(offenders).toEqual([]);
  });
});
