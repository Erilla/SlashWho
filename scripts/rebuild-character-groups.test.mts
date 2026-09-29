import { describe, expect, it } from "vitest";

import { rebuildTarget } from "./rebuild-character-groups.mts";

const databaseUrl =
  "postgresql://postgres:s3cret-password@shinkansen.proxy.rlwy.net:41234/railway";
const target = "shinkansen.proxy.rlwy.net:41234/railway";

describe("character groups rebuild target", () => {
  // Break caught: the rebuild needed only DATABASE_URL, so a shell still
  // holding another environment's URL rebuilt that environment silently.
  it("names host, port and database, and runs only when --confirm matches", () => {
    expect(
      rebuildTarget(["--confirm", target], { DATABASE_URL: databaseUrl })
    ).toEqual({ target });
  });

  it("refuses without --confirm, naming the target and never the password", () => {
    expect(() => rebuildTarget([], { DATABASE_URL: databaseUrl })).toThrow(
      `rebuild refused: pass --confirm ${target} to rebuild the character groups on ${target}`
    );
    try {
      rebuildTarget([], { DATABASE_URL: databaseUrl });
    } catch (error) {
      expect((error as Error).message).not.toContain("s3cret");
      expect((error as Error).message).not.toContain("postgres:");
    }
  });

  // Break caught: Railway's proxy hosts are shared across environments and
  // differ only by port, so confirming the hostname alone let a shell holding
  // production's URL pass a confirmation meant for test.
  it("refuses a --confirm naming another host, port or database", () => {
    for (const other of [
      "maglev.proxy.rlwy.net:41234/railway",
      "shinkansen.proxy.rlwy.net:52001/railway",
      "shinkansen.proxy.rlwy.net:41234/other",
      "shinkansen.proxy.rlwy.net"
    ]) {
      expect(() =>
        rebuildTarget(["--confirm", other], { DATABASE_URL: databaseUrl })
      ).toThrow(`rebuild refused: pass --confirm ${target}`);
    }
    expect(() =>
      rebuildTarget(["--confirm"], { DATABASE_URL: databaseUrl })
    ).toThrow("rebuild refused");
  });

  it("needs a DATABASE_URL it can read a host and database from", () => {
    expect(() => rebuildTarget(["--confirm", "x"], {})).toThrow(
      "database_url_required"
    );
    expect(() =>
      rebuildTarget(["--confirm", "x"], { DATABASE_URL: "not a url" })
    ).toThrow("database_url_invalid");
    expect(() =>
      rebuildTarget(["--confirm", "x"], {
        DATABASE_URL: "postgresql://postgres:pw@shinkansen.proxy.rlwy.net:41234"
      })
    ).toThrow("database_url_invalid");
  });
});
