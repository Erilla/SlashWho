import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const apiRoot = import.meta.dirname;

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

describe("API route handlers", () => {
  it("answer every request through withHttpRequest", () => {
    // Break caught: withHttpRequest is what marks a response no-store when the
    // handler names no caching policy, so a handler that bypasses it could let
    // an assembled dossier be cached (CLAUDE.md: always no-store).
    const files = routeFiles(apiRoot);
    expect(files.length).toBeGreaterThan(0);
    const bypassing = files
      .filter(
        (file) => !readFileSync(file, "utf8").includes("withHttpRequest(")
      )
      .map((file) => relative(apiRoot, file));
    expect(bypassing).toEqual([]);
  });
});
