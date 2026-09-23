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
