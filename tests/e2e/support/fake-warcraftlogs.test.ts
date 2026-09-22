import { afterEach, describe, expect, it } from "vitest";

import { startFakeWarcraftLogs } from "./fake-warcraftlogs";

describe("startFakeWarcraftLogs", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
  });

  it("does not retain historic reports for Ryii's refreshed demo data", async () => {
    // Break caught: the demo can keep showing synthetic historic evidence that
    // is not part of Ryii's approved current public source data.
    const fixture = await startFakeWarcraftLogs();
    close = fixture.close;
    const response = await fetch(`${fixture.baseUrl}/api/v2/client`, {
      method: "POST",
      body: JSON.stringify({ variables: { name: "ryii", realm: "silvermoon" } })
    });
    const body = (await response.json()) as {
      data: {
        characterData: { character: { recentReports: { data: unknown[] } } };
      };
    };

    expect(response.ok).toBe(true);
    expect(body.data.characterData.character.recentReports.data).toEqual([]);
  });
});
