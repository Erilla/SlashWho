import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isMainModule } from "./cli.mts";

describe("isMainModule", () => {
  // Built from this platform's own paths, so the suite exercises the check the
  // way it runs here: an absolute POSIX path on Linux and macOS, a drive
  // letter on Windows.
  const script = resolve("scripts", "generate-raid-catalogue.mts");
  const moduleUrl = pathToFileURL(script).href;

  it("recognises the script it was invoked as", () => {
    expect(isMainModule(moduleUrl, script)).toBe(true);
  });

  it("recognises a relative invocation path", () => {
    expect(isMainModule(moduleUrl, "scripts/generate-raid-catalogue.mts")).toBe(
      true
    );
  });

  it("recognises a script whose path contains a space", () => {
    const spaced = resolve("my scripts", "generate-raid-catalogue.mts");
    expect(isMainModule(pathToFileURL(spaced).href, spaced)).toBe(true);
  });

  it("rejects a module imported by a different entry point", () => {
    expect(
      isMainModule(
        moduleUrl,
        resolve("scripts", "generate-dungeon-catalogue.mts")
      )
    ).toBe(false);
  });

  it("rejects a process with no invoked script", () => {
    expect(isMainModule(moduleUrl, undefined)).toBe(false);
  });
});
