import { describe, expect, it } from "vitest";

import { rebuildTarget } from "./rebuild-character-groups.mts";

const databaseUrl =
  "postgresql://postgres:s3cret-password@shinkansen.proxy.rlwy.net:41234/railway";

describe("character groups rebuild target", () => {
  // Break caught: the rebuild needed only DATABASE_URL, so a shell still
  // holding another environment's URL rebuilt that environment silently.
  it("names the host and runs only when --confirm matches it", () => {
    expect(
      rebuildTarget(["--confirm", "shinkansen.proxy.rlwy.net"], {
        DATABASE_URL: databaseUrl
      })
    ).toEqual({ host: "shinkansen.proxy.rlwy.net" });
  });

  it("refuses without --confirm, naming the host and never the password", () => {
    expect(() => rebuildTarget([], { DATABASE_URL: databaseUrl })).toThrow(
      "rebuild refused: pass --confirm shinkansen.proxy.rlwy.net to rebuild the character groups on shinkansen.proxy.rlwy.net"
    );
    try {
      rebuildTarget([], { DATABASE_URL: databaseUrl });
    } catch (error) {
      expect((error as Error).message).not.toContain("s3cret");
      expect((error as Error).message).not.toContain("postgres:");
    }
  });

  it("refuses a --confirm naming another host", () => {
    expect(() =>
      rebuildTarget(["--confirm", "maglev.proxy.rlwy.net"], {
        DATABASE_URL: databaseUrl
      })
    ).toThrow("rebuild refused: pass --confirm shinkansen.proxy.rlwy.net");
    expect(() =>
      rebuildTarget(["--confirm"], { DATABASE_URL: databaseUrl })
    ).toThrow("rebuild refused");
  });

  it("needs a DATABASE_URL it can read a host from", () => {
    expect(() => rebuildTarget(["--confirm", "x"], {})).toThrow(
      "database_url_required"
    );
    expect(() =>
      rebuildTarget(["--confirm", "x"], { DATABASE_URL: "not a url" })
    ).toThrow("database_url_invalid");
  });
});
