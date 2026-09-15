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

  it("keeps the evidence_job performance fields", () => {
    const lines: string[] = [];
    const logger = createWorkerLogger({
      write: (line: string) => lines.push(line)
    } as never);

    logger.info({
      event: "evidence_job",
      runId: "run-1",
      correlationId: "c1",
      durationMs: 50,
      queueWaitMs: 2_000,
      warcraftLogsMs: 40,
      warcraftLogsCalls: 1,
      warcraftLogsMaxCallMs: 40,
      dbMs: 10,
      dbCalls: 2,
      dbMaxCallMs: 6,
      outcome: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      requestCapUsed: 80,
      killCount: 4
    });

    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      expect(value, `${key} was redacted`).not.toBe("[Redacted]");
    }
  });

  it("censors a visitor's upstream credential under every key that could carry one", () => {
    // Break caught: this logger is a denylist, so a credential field added to
    // a worker record later would be printed verbatim. The evidence job now
    // handles visitor-supplied Warcraft Logs keys, which makes this the
    // highest-stakes name set in the file.
    const marker = "visitor-supplied-secret-value";
    const lines: string[] = [];
    const logger = createWorkerLogger({
      write: (line: string) => lines.push(line)
    } as never);

    logger.info({
      event: "evidence_job",
      clientId: marker,
      clientSecret: marker,
      accessKey: marker,
      apiKey: marker,
      secret: marker,
      credentials: marker,
      run: {
        wclClientId: marker,
        wclClientSecret: marker,
        wclClientIdEncrypted: marker,
        wclClientSecretEncrypted: marker,
        credential: marker
      }
    });

    expect(lines[0]).toContain("evidence_job");
    expect(lines[0]).not.toContain(marker);
  });

  it("redacts provider-prefixed and other credential names not literally listed", () => {
    // Break caught: a security review found these seven credential-bearing
    // names reachable in worker payloads but not caught by the denylist,
    // because exact matching can't survive a provider prefix. This proves
    // the substring backstop closes the gap, including when nested.
    const marker = "UNIQUE_PROVIDER_CREDENTIAL_MARKER_7c2ab1";
    const lines: string[] = [];
    const logger = createWorkerLogger({
      write: (line: string) => lines.push(line)
    } as never);

    logger.info({
      event: "evidence_job",
      config: {
        blizzardClientId: marker,
        blizzardClientSecret: marker,
        warcraftLogsClientId: marker,
        warcraftLogsClientSecret: marker,
        evidenceJobCredentialEncryptionKey: marker,
        databaseUrl: marker
      },
      options: {
        decryptionKey: marker
      }
    });

    expect(lines[0]).toContain("evidence_job");
    expect(lines[0]).not.toContain(marker);
  });

  it("does not redact ordinary telemetry fields that this branch exists to produce", () => {
    // Break caught: widening the matcher to a substring rule could quietly
    // swallow unrelated fields that merely share letters with a credential
    // name (e.g. providerName, characterCount), silencing the telemetry.
    const lines: string[] = [];
    const logger = createWorkerLogger({
      write: (line: string) => lines.push(line)
    } as never);

    logger.info({
      event: "evidence_job",
      provider: "warcraftlogs",
      durationMs: 50,
      characterCount: 3,
      correlationId: "c1",
      outcome: "complete"
    });

    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record.provider).toBe("warcraftlogs");
    expect(record.durationMs).toBe(50);
    expect(record.characterCount).toBe(3);
    expect(record.correlationId).toBe("c1");
    expect(record.outcome).toBe("complete");
  });
});
