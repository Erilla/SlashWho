import { describe, expect, it } from "vitest";

import {
  compareProbe,
  exitCode,
  loadRecordings,
  renderReport,
  targetsFromEnvironment,
  type LabelledRecording,
  type ProbeInput
} from "./provider-drift.mts";
import { TargetError } from "./provider-fetch.mts";
import {
  PlaceholderBook,
  recordPayload,
  type Endpoint
} from "./recorded-payloads.mts";

const recordedOn = "2026-09-26";

function claimedCharacter(discord: string | null = "someone") {
  return {
    characterDetails: {
      character: {
        name: "Ryii",
        class: { name: "Rogue" },
        level: 90,
        realm: { slug: "silvermoon", realmType: "live" },
        region: { slug: "eu" },
        guild: {
          name: "Real Guild",
          realm: { slug: "silvermoon" },
          region: { slug: "eu" }
        },
        gear: { itemLevel: 700 }
      },
      characterCustomizations: {
        main_character: null,
        discord_profile: discord
      },
      user: { name: "real-owner" },
      isTournamentProfile: false,
      mythicPlusScores: { all: 3000 }
    }
  };
}

function roster(member: Record<string, unknown>) {
  return {
    guild: { name: "Real Guild" },
    members: [
      {
        character: {
          name: "Ryii",
          level: 90,
          realm: { slug: "silvermoon" },
          ...member
        },
        rank: 1
      }
    ]
  };
}

function recorded(
  label: string,
  endpoint: Endpoint,
  body: unknown,
  status = 200
): LabelledRecording {
  return {
    label,
    recording: recordPayload(body, {
      endpoint,
      status,
      recordedOn,
      book: new PlaceholderBook()
    })
  };
}

function probe(
  endpoint: Endpoint,
  label: string,
  body: unknown,
  status = 200
): ProbeInput {
  return { endpoint, label, live: { status, body } };
}

const claimed = recorded("claimed", "raiderio.character", claimedCharacter());

describe("compareProbe", () => {
  it("reports an unchanged response as unchanged", () => {
    const result = compareProbe(
      probe("raiderio.character", "claimed", claimedCharacter()),
      [claimed],
      recordedOn
    );
    expect(result).toMatchObject({
      outcome: "unchanged",
      read: [],
      ignored: [],
      liveStatus: 200,
      recordedStatus: 200
    });
    expect(exitCode([result])).toBe(0);
  });

  it("fails on an empty string no recording has shown (#35)", () => {
    const result = compareProbe(
      probe("raiderio.character", "claimed", claimedCharacter("")),
      [claimed],
      recordedOn
    );
    expect(result.outcome).toBe("read-drift");
    expect(result.read).toEqual([
      "+ characterDetails.characterCustomizations.discord_profile: empty-string (no recording shows it)",
      "- characterDetails.characterCustomizations.discord_profile: string (recorded, now missing)"
    ]);
    expect(exitCode([result])).toBe(1);
  });

  it("accepts a kind another recording of the endpoint has shown", () => {
    const withoutDiscord = recorded(
      "no-discord",
      "raiderio.character",
      claimedCharacter(null)
    );
    const result = compareProbe(
      probe("raiderio.character", "no-discord", claimedCharacter(null)),
      [claimed, withoutDiscord],
      recordedOn
    );
    expect(result.outcome).toBe("unchanged");
  });

  it("fails when a roster field we read stops arriving (#38)", () => {
    const baseline = recorded(
      "root-guild",
      "blizzard.guild-roster",
      roster({ playable_class: { id: 4 } })
    );
    const result = compareProbe(
      probe(
        "blizzard.guild-roster",
        "root-guild",
        roster({ playable_class: {} })
      ),
      [baseline],
      recordedOn
    );
    expect(result.outcome).toBe("read-drift");
    expect(result.read).toEqual([
      "- members[].character.playable_class.id: number (recorded, now missing)"
    ]);
  });

  it("fails when a recorded status changes (#36)", () => {
    const privateProfile = {
      statusCode: 403,
      error: "Forbidden",
      message: "The requested user's profile is private and cannot be viewed.",
      errorCode: "profile_is_private"
    };
    const baseline = recorded(
      "private-owner",
      "raiderio.view-characters",
      privateProfile,
      403
    );
    const result = compareProbe(
      probe(
        "raiderio.view-characters",
        "private-owner",
        { statusCode: 404, error: "Not Found", message: "Cannot find user" },
        404
      ),
      [baseline],
      recordedOn
    );
    expect(result.outcome).toBe("read-drift");
    expect(result.read[0]).toBe("status 403 is now 404");
  });

  it("fails on a value the allow-list cannot classify, naming only its path", () => {
    const result = compareProbe(
      probe(
        "raiderio.character",
        "unknown-name",
        {
          statusCode: 400,
          error: "Bad Request",
          message: "Could not find ryii on silvermoon"
        },
        400
      ),
      [],
      recordedOn
    );
    expect(result.outcome).toBe("read-drift");
    expect(result.read).toEqual([
      "cannot classify: unrecognised_value at message"
    ]);
    expect(renderReport([result], recordedOn)).not.toMatch(/ryii|silvermoon/i);
  });

  it("only warns when a field we ignore appears or disappears", () => {
    const live: { characterDetails: Record<string, unknown> } =
      claimedCharacter();
    delete live.characterDetails.mythicPlusScores;
    live.characterDetails.raidProgression = {};
    const result = compareProbe(
      probe("raiderio.character", "claimed", live),
      [claimed],
      recordedOn
    );
    expect(result.outcome).toBe("ignored-drift");
    expect(result.read).toEqual([]);
    expect(result.ignored).toEqual([
      "+ characterDetails.raidProgression",
      "- characterDetails.mythicPlusScores"
    ]);
    expect(exitCode([result])).toBe(0);
  });

  it("notes a recording that predates its ignored-field baseline", () => {
    const older = { ...claimed.recording, ignored: undefined };
    const result = compareProbe(
      probe("raiderio.character", "claimed", claimedCharacter()),
      [{ label: "claimed", recording: older }],
      recordedOn
    );
    expect(result.outcome).toBe("unchanged");
    expect(result.notes).toEqual([
      "the recording predates its ignored-field baseline; re-record it to compare fields we ignore"
    ]);
  });

  it("warns rather than fails for an endpoint nothing has recorded", () => {
    const result = compareProbe(
      probe("blizzard.character-profile", "root", {
        guild: { name: "Real Guild", realm: { slug: "silvermoon" } }
      }),
      [],
      recordedOn
    );
    expect(result.outcome).toBe("unbaselined");
    expect(result.read).toEqual([]);
    expect(exitCode([result])).toBe(0);
  });

  it("treats a throttle, an outage or a failed request as inconclusive", () => {
    const outage = compareProbe(
      probe("raiderio.character", "claimed", null, 503),
      [claimed],
      recordedOn
    );
    const failed = compareProbe(
      {
        endpoint: "raiderio.character",
        label: "claimed",
        live: { error: "request_failed" }
      },
      [claimed],
      recordedOn
    );
    expect(outage.outcome).toBe("inconclusive");
    expect(failed.outcome).toBe("inconclusive");
    expect(exitCode([outage, failed])).toBe(3);
    expect(
      exitCode([
        outage,
        failed,
        compareProbe(
          probe("raiderio.character", "claimed", claimedCharacter("")),
          [claimed],
          recordedOn
        )
      ])
    ).toBe(1);
  });

  it("finds every committed recording unchanged against itself", () => {
    const recordings = loadRecordings();
    expect(recordings.length).toBeGreaterThan(0);
    for (const { label, recording } of recordings) {
      const result = compareProbe(
        probe(recording.endpoint, label, recording.body, recording.status),
        recordings,
        recordedOn
      );
      expect(result.read, `${recording.endpoint}:${label}`).toEqual([]);
    }
  });
});

describe("renderReport", () => {
  it("never carries a live value, even as a field name", () => {
    const live = claimedCharacter("ryii-discord");
    const body = {
      characterDetails: {
        ...live.characterDetails,
        Ryii: { note: "Ryii's alt" },
        "real-owner": true
      }
    };
    const results = [
      compareProbe(
        probe("raiderio.character", "claimed", body),
        [claimed],
        recordedOn
      ),
      compareProbe(
        probe("raiderio.character", "claimed", claimedCharacter("")),
        [claimed],
        recordedOn
      )
    ];
    const report = renderReport(results, recordedOn);
    expect(results[0]!.ignored).toEqual(["+ characterDetails.<key>"]);
    for (const value of [
      "ryii",
      "real guild",
      "real-owner",
      "someone",
      "700",
      "3000"
    ])
      expect(report.toLocaleLowerCase("en-US")).not.toContain(value);
    expect(report).toContain("**drift in fields we read**");
  });
});

describe("targetsFromEnvironment", () => {
  it("reads both providers' targets in the recorder's syntax", () => {
    expect(
      targetsFromEnvironment({
        PROVIDER_DRIFT_RAIDERIO_TARGETS:
          " character:claimed=eu/silvermoon/a\nview-characters:claimed=owner-of:eu/silvermoon/a ",
        PROVIDER_DRIFT_BLIZZARD_TARGETS: "playable-class-index:eu=eu"
      })
    ).toEqual([
      {
        endpoint: "raiderio.character",
        label: "claimed",
        target: "eu/silvermoon/a"
      },
      {
        endpoint: "raiderio.view-characters",
        label: "claimed",
        target: "owner-of:eu/silvermoon/a"
      },
      {
        endpoint: "blizzard.playable-class-index",
        label: "eu",
        target: "eu"
      }
    ]);
  });

  it("refuses to run with nothing to probe", () => {
    expect(() => targetsFromEnvironment({})).toThrow(
      "no drift targets configured"
    );
  });

  it("refuses a malformed character target before any request", () => {
    for (const value of [
      "character:claimed=eu/silvermoon",
      "view-characters:claimed=owner-of:eu/silvermoon"
    ])
      expect(() =>
        targetsFromEnvironment({ PROVIDER_DRIFT_RAIDERIO_TARGETS: value })
      ).toThrow(TargetError);
    expect(
      targetsFromEnvironment({
        PROVIDER_DRIFT_RAIDERIO_TARGETS: "view-characters:claimed=some-owner"
      })
    ).toHaveLength(1);
  });
});
