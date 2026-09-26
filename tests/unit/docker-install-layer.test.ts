import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// Both images copy the workspace manifests ahead of `pnpm install` so the
// install layer caches until a manifest or the lockfile changes. The list is
// kept by hand, so a package added to the workspace and left out here would
// install against a missing link target, and only `COPY . .` afterwards would
// hide it (#570).
async function workspaceManifests(): Promise<string[]> {
  const manifests: string[] = [];
  for (const parent of ["apps", "packages"]) {
    const entries = await readdir(
      new URL(`../../${parent}/`, import.meta.url),
      {
        withFileTypes: true
      }
    );
    for (const entry of entries) {
      if (entry.isDirectory()) {
        manifests.push(`${parent}/${entry.name}/package.json`);
      }
    }
  }
  return manifests.sort();
}

// The Dockerfile's instructions up to the dependency install, which is the
// part of the build the manifest copies have to precede.
async function installLayer(image: string): Promise<string> {
  const dockerfile = await readFile(
    `${repositoryRoot}Dockerfile.${image}`,
    "utf8"
  );
  const install = dockerfile.indexOf("RUN pnpm install");
  expect(install).toBeGreaterThan(-1);
  return dockerfile.slice(0, install);
}

describe.each(["web", "worker"])("%s image install layer", (image) => {
  it("copies every workspace package manifest", async () => {
    const layer = await installLayer(image);
    const manifests = await workspaceManifests();

    expect(manifests.length).toBeGreaterThan(0);
    for (const manifest of manifests) {
      expect(layer).toContain(`COPY ${manifest} ${manifest}`);
    }
  });

  it("copies the root install configuration", async () => {
    const layer = await installLayer(image);
    const rootCopy = layer
      .split("\n")
      .find((line) => line.startsWith("COPY package.json "));

    for (const file of [
      ".npmrc",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml"
    ]) {
      expect(rootCopy?.split(" ")).toContain(file);
    }
  });
});
