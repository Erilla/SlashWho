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
      linkCell: "https://raider.io/characters/eu/example/aria"
    },
    {
      row: 3,
      battletag: undefined,
      discordId: undefined,
      characterName: undefined,
      linkCell: undefined
    },
    {
      row: 4,
      battletag: "Two#456",
      discordId: "222",
      characterName: "Bela",
      linkCell: "https://raider.io/characters/eu/example/bela"
    }
  ]);
});
