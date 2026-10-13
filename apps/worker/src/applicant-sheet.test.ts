import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createApplicantSheetClient } from "./applicant-sheet";

it("requests only the configured response column with a read-only scope", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" }
  });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("oauth2")) {
      const assertion = new URLSearchParams(init?.body as string).get(
        "assertion"
      )!;
      const payload = JSON.parse(
        Buffer.from(assertion.split(".")[1]!, "base64url").toString()
      ) as { scope: string };
      expect(payload.scope).toBe(
        "https://www.googleapis.com/auth/spreadsheets.readonly"
      );
      return new Response(JSON.stringify({ access_token: "fake-token" }));
    }
    expect(decodeURIComponent(url)).toContain("'Form Responses'!G2:G");
    expect(url).not.toContain("A2:");
    return new Response(
      JSON.stringify({
        values: [["https://raider.io/characters/eu/example/aria"]]
      })
    );
  });
  const cells = await createApplicantSheetClient({
    sheetId: "fake-sheet",
    column: "G",
    email: "fake@example.test",
    privateKey,
    fetch: fetch as typeof globalThis.fetch
  }).readColumn();
  expect(cells).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("reads a public response column with an API key and no OAuth request", async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toContain("sheets.googleapis.com/v4/spreadsheets/fake-sheet");
    expect(decodeURIComponent(url)).toContain("'Form Responses'!F2:F");
    expect(url).not.toContain("test-api-key");
    expect(init?.headers).toEqual({ "x-goog-api-key": "test-api-key" });
    return new Response(JSON.stringify({ values: [["character-link"]] }));
  });

  const cells = await createApplicantSheetClient({
    sheetId: "fake-sheet",
    column: "F",
    apiKey: "test-api-key",
    fetch: fetch as typeof globalThis.fetch
  }).readColumn();

  expect(cells).toEqual(["character-link"]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("reads applicant details and character links from separate ranges without adjacent answers", async () => {
  const fetch = vi.fn(async (url: string) => {
    const ranges = new URL(url).searchParams.getAll("ranges");
    if (decodeURIComponent(url).includes("UNFORMATTED_VALUE")) {
      expect(ranges).toEqual([
        "'Form Responses'!A2:A",
        "'Form Responses'!F2:F"
      ]);
      return new Response(
        JSON.stringify({
          valueRanges: [
            { values: [[46308.1], [], [46308.3]] },
            {
              values: [
                ["https://raider.io/characters/eu/example/aria"],
                [],
                ["https://raider.io/characters/eu/example/bela"]
              ]
            }
          ]
        })
      );
    }
    expect(ranges).toEqual(["'Form Responses'!B2:D", "'Form Responses'!F2:F"]);
    return new Response(
      JSON.stringify({
        valueRanges: [
          {
            values: [["One#123", "111", "Aria"], [], ["Two#456", "222", "Bela"]]
          },
          {
            values: [
              ["https://raider.io/characters/eu/example/aria"],
              [],
              ["https://raider.io/characters/eu/example/bela"]
            ]
          }
        ]
      })
    );
  });
  const rows = await createApplicantSheetClient({
    sheetId: "fake-sheet",
    column: "F",
    apiKey: "test-api-key",
    fetch: fetch as typeof globalThis.fetch
  }).readRows();
  expect(rows).toEqual([
    {
      row: 2,
      battletag: "One#123",
      discordId: "111",
      characterName: "Aria",
      linkCell: "https://raider.io/characters/eu/example/aria",
      submittedSerial: 46308.1
    },
    {
      row: 3,
      battletag: undefined,
      discordId: undefined,
      characterName: undefined,
      linkCell: undefined,
      submittedSerial: undefined
    },
    {
      row: 4,
      battletag: "Two#456",
      discordId: "222",
      characterName: "Bela",
      linkCell: "https://raider.io/characters/eu/example/bela",
      submittedSerial: 46308.3
    }
  ]);
});

it("reuses a service-account token until a minute before it expires", async () => {
  // Break caught: every read minted a new token, 1,440 token requests a day
  // at a one-minute cadence.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(start);
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" }
    });
    let tokens = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("oauth2")) {
        tokens++;
        return new Response(
          JSON.stringify({ access_token: `token-${tokens}`, expires_in: 3600 })
        );
      }
      return new Response(JSON.stringify({ values: [] }));
    });
    const client = createApplicantSheetClient({
      sheetId: "fake-sheet",
      column: "F",
      email: "fake@example.test",
      privateKey,
      fetch: fetch as typeof globalThis.fetch
    });

    await client.readColumn();
    vi.setSystemTime(start + 3_539_000);
    await client.readColumn();
    expect(tokens).toBe(1);

    vi.setSystemTime(start + 3_541_000);
    await client.readColumn();
    expect(tokens).toBe(2);
    const lastRead = fetch.mock.calls.at(-1) as unknown as [
      string,
      RequestInit
    ];
    expect((lastRead[1].headers as Record<string, string>).authorization).toBe(
      "Bearer token-2"
    );
  } finally {
    vi.useRealTimers();
  }
});

it("mints a new token after a read is rejected with 401 or 403", async () => {
  // Break caught: a revoked token stayed cached for up to an hour, failing
  // every minute's read until it expired.
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" }
  });
  for (const status of [401, 403]) {
    let tokens = 0;
    let rejectNext = false;
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("oauth2")) {
        tokens++;
        return new Response(
          JSON.stringify({ access_token: `token-${tokens}`, expires_in: 3600 })
        );
      }
      if (rejectNext) {
        rejectNext = false;
        return new Response("{}", { status });
      }
      return new Response(JSON.stringify({ values: [] }));
    });
    const client = createApplicantSheetClient({
      sheetId: "fake-sheet",
      column: "F",
      email: "fake@example.test",
      privateKey,
      fetch: fetch as typeof globalThis.fetch
    });

    await client.readColumn();
    expect(tokens).toBe(1);

    rejectNext = true;
    await expect(client.readColumn()).rejects.toThrow(
      "applicant_sheet_read_rejected"
    );
    expect(tokens).toBe(1);

    await client.readColumn();
    expect(tokens).toBe(2);
  }
});

function sheetFetch(
  first: unknown[][],
  second: { serials: unknown[][]; links: unknown[][] }
) {
  return vi.fn(async (url: string) => {
    const decoded = decodeURIComponent(url);
    if (decoded.includes("UNFORMATTED_VALUE")) {
      expect(decoded).toContain("dateTimeRenderOption=SERIAL_NUMBER");
      expect(decoded).toContain("'Form Responses'!A2:A");
      return new Response(
        JSON.stringify({
          valueRanges: [{ values: second.serials }, { values: second.links }]
        })
      );
    }
    return new Response(
      JSON.stringify({
        valueRanges: [
          { values: first.map(() => ["tag#1", "123456789012345678", "Name"]) },
          { values: first }
        ]
      })
    );
  });
}

it("attaches each row's Forms timestamp as a raw serial", async () => {
  const fetch = sheetFetch(
    [["https://raider.io/characters/eu/hyjal/tropipe"]],
    {
      serials: [[46308.4501]],
      links: [["https://raider.io/characters/eu/hyjal/tropipe"]]
    }
  );
  const rows = await createApplicantSheetClient({
    sheetId: "s",
    column: "F",
    apiKey: "k",
    fetch: fetch as typeof globalThis.fetch
  }).readRows();
  expect(rows[0]).toMatchObject({ row: 2, submittedSerial: 46308.4501 });
  // The formatted read keeps an 18-digit Discord id exact.
  expect(rows[0]?.discordId).toBe("123456789012345678");
});

it("drops rows appended between the two reads", async () => {
  const fetch = sheetFetch([["https://raider.io/characters/eu/hyjal/a"]], {
    serials: [[1], [2]],
    links: [
      ["https://raider.io/characters/eu/hyjal/a"],
      ["https://raider.io/characters/eu/hyjal/b"]
    ]
  });
  const rows = await createApplicantSheetClient({
    sheetId: "s",
    column: "F",
    apiKey: "k",
    fetch: fetch as typeof globalThis.fetch
  }).readRows();
  expect(rows).toHaveLength(1);
});

it("fails the read when the sheet was sorted or a row deleted between reads", async () => {
  // Break caught: a sort between the reads paired one applicant's timestamp
  // with another's links, and linked the wrong person's characters.
  const sorted = sheetFetch(
    [
      ["https://raider.io/characters/eu/hyjal/a"],
      ["https://raider.io/characters/eu/hyjal/b"]
    ],
    {
      serials: [[2], [1]],
      links: [
        ["https://raider.io/characters/eu/hyjal/b"],
        ["https://raider.io/characters/eu/hyjal/a"]
      ]
    }
  );
  await expect(
    createApplicantSheetClient({
      sheetId: "s",
      column: "F",
      apiKey: "k",
      fetch: sorted as typeof globalThis.fetch
    }).readRows()
  ).rejects.toThrow("applicant_sheet_rows_moved");
  const deleted = sheetFetch(
    [
      ["https://raider.io/characters/eu/hyjal/a"],
      ["https://raider.io/characters/eu/hyjal/b"]
    ],
    { serials: [[1]], links: [["https://raider.io/characters/eu/hyjal/a"]] }
  );
  await expect(
    createApplicantSheetClient({
      sheetId: "s",
      column: "F",
      apiKey: "k",
      fetch: deleted as typeof globalThis.fetch
    }).readRows()
  ).rejects.toThrow("applicant_sheet_rows_moved");
});

it("accepts a numeric or boolean link cell that renders differently in the two reads", async () => {
  // Break caught: comparing the formatted cell with the unformatted one by
  // `!==` failed on a response holding a bare number (a pasted WCL or Discord
  // id), so every poll failed and all intake stopped until the sheet was edited.
  const fetch = sheetFetch(
    [["123456"], ["TRUE"], ["https://raider.io/characters/eu/hyjal/a"]],
    {
      serials: [[1], [2], [3]],
      links: [[123456], [true], ["https://raider.io/characters/eu/hyjal/a"]]
    }
  );
  const rows = await createApplicantSheetClient({
    sheetId: "s",
    column: "F",
    apiKey: "k",
    fetch: fetch as typeof globalThis.fetch
  }).readRows();
  expect(rows.map((row) => row.submittedSerial)).toEqual([1, 2, 3]);
});
