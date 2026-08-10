import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createWorkerLogger } from "./logger";

describe("worker logger", () => {
  it("redacts credentials, bodies, and private lookup values", async () => {
    // Break caught: sensitive lookup or request values could enter structured logs.
    const marker = "UNIQUE_PRIVATE_MARKER_9f103d";
    const output = new PassThrough();
    let captured = "";
    output.on("data", (chunk) => {
      captured += chunk.toString();
    });
    const logger = createWorkerLogger(output);

    logger.info(
      {
        authorization: marker,
        cookie: marker,
        ownerId: marker,
        profileGuess: marker,
        validationName: marker,
        req: {
          headers: { authorization: marker, cookie: marker },
          body: { rawUpstreamPayload: marker }
        },
        context: {
          upstream: {
            owner_id: marker,
            validation_name: marker
          }
        }
      },
      "safe_event"
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(captured).toContain("safe_event");
    expect(captured).not.toContain(marker);
  });

  it("handles cycles and redacts generic private lookup keys", async () => {
    // Break caught: cyclic diagnostic data could crash logging or expose lookup secrets.
    const marker = "UNIQUE_CYCLIC_MARKER_b6221e";
    const output = new PassThrough();
    let captured = "";
    output.on("data", (chunk) => {
      captured += chunk.toString();
    });
    const logger = createWorkerLogger(output);
    const value: Record<string, unknown> = {
      region: "eu",
      realm: "silvermoon",
      name: "normalized-root",
      rawUrl: marker,
      owner: marker,
      profile: marker,
      validationGuess: marker
    };
    value.self = value;

    expect(() => logger.info({ value }, "cyclic_event")).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(captured).toContain("normalized-root");
    expect(captured).toContain("[Circular]");
    expect(captured).not.toContain(marker);
  });

  it("redacts every ephemeral fingerprint and credential marker", async () => {
    // Break caught: diagnostic objects could serialize achievement material,
    // access tokens, or comparison scores outside the handler allowlist.
    const marker = "UNIQUE_FINGERPRINT_MARKER_414f8b";
    const output = new PassThrough();
    let captured = "";
    output.on("data", (chunk) => {
      captured += chunk.toString();
    });
    const logger = createWorkerLogger(output);

    logger.info(
      {
        achievementId: marker,
        achievementIds: marker,
        achievementTimestamp: marker,
        completionTimestamp: marker,
        accessToken: marker,
        refreshToken: marker,
        fingerprint: marker,
        fingerprintScore: marker,
        matchScore: marker,
        identicalPercent: marker,
        nested: {
          achievements: marker,
          timestamps: marker,
          token: marker,
          score: marker
        }
      },
      "fingerprint_event"
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(captured).toContain("fingerprint_event");
    expect(captured).not.toContain(marker);
  });
});
