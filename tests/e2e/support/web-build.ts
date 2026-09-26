import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type WebBuildFreshness = "missing" | "stale" | "fresh";

// Everything the web bundle is compiled from. The app transpiles the workspace
// packages from source, so an edit under packages/ changes the bundle too.
const inputFiles = ["package.json", "pnpm-lock.yaml", "tsconfig.base.json"];
const inputDirectories = ["apps/web", "packages"];
const ignoredDirectories = new Set([".next", "node_modules", "dist", ".turbo"]);

function newestModification(path: string): number {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.mtimeMs;
  // A directory's own time records deletions, which leave no file to date.
  let newest = stats.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    newest = Math.max(newest, newestModification(join(path, entry.name)));
  }
  return newest;
}

/**
 * Whether apps/web/.next holds a production build of the current sources.
 * Browser tests run against that build, so a stale one would pass or fail on
 * code that is no longer in the tree.
 */
export function webBuildFreshness(root: string): WebBuildFreshness {
  let builtAt: number;
  try {
    builtAt = statSync(join(root, "apps/web/.next/BUILD_ID")).mtimeMs;
  } catch {
    return "missing";
  }
  const newestInput = Math.max(
    ...inputFiles.map((file) => statSync(join(root, file)).mtimeMs),
    ...inputDirectories.map((directory) =>
      newestModification(join(root, directory))
    )
  );
  return newestInput > builtAt ? "stale" : "fresh";
}
