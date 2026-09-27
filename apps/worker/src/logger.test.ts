import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createWorkerLogger, redactSensitive } from "./logger";

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

  it("handles cycles and redacts generic private lookup keys", () => {
    // Break caught: cyclic diagnostic data could crash logging or expose lookup
    // secrets. The allowlist drops an unlisted object outright, so this pins
    // the backstop that runs over a kept one.
    const marker = "UNIQUE_CYCLIC_MARKER_b6221e";
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

    let redacted: unknown;
    expect(() => (redacted = redactSensitive({ value }))).not.toThrow();
    const serialized = JSON.stringify(redacted);

    expect(serialized).toContain("normalized-root");
    expect(serialized).toContain("[Circular]");
    expect(serialized).not.toContain(marker);
  });

  it("censors a credential nested inside a field the allowlist keeps", () => {
    // Break caught: `queues` is kept whole, so a secret that reached it would
    // print unless the backstop still ran over kept fields.
    const marker = "UNIQUE_NESTED_KEPT_MARKER_31d0aa";
    const lines: string[] = [];
    const logger = createWorkerLogger({
      write: (line: string) => lines.push(line)
    });

    logger.info({
      event: "queue_depth",
      queues: { "discover-character": { depth: 1, clientSecret: marker } }
    });

    const record = JSON.parse(lines[0]!) as {
      queues: Record<string, Record<string, unknown>>;
    };
    expect(record.queues["discover-character"]).toEqual({
      depth: 1,
      clientSecret: "[Redacted]"
    });
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
    });

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
      dbMaxCallName: "applicantRuns.claimNext",
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
    });

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
    });

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

  it("redacts a webhook url, whose path is itself the credential", () => {
    // Break caught: a webhook URL carries its secret in the path, so logging
    // one in full hands over the ability to post as us.
    const marker = "UNIQUE_WEBHOOK_MARKER_4f91ce";
    const lines: string[] = [];
    const logger = createWorkerLogger({
      write: (line: string) => lines.push(line)
    });

    logger.info({
      event: "worker_config",
      config: {
        discoveryWebhookUrl: `https://discord.com/api/webhooks/1/${marker}`,
        maintainerAlertWebhookUrl: `https://hooks.example.test/${marker}`
      }
    });

    expect(lines[0]).toContain("worker_config");
    expect(lines[0]).not.toContain(marker);
  });

  it("does not redact ordinary telemetry fields that this branch exists to produce", () => {
    // Break caught: widening the matcher to a substring rule could quietly
    // swallow unrelated fields that merely share letters with a credential
    // name (e.g. providerName, characterCount), silencing the telemetry.
    const lines: string[] = [];
    const logger = createWorkerLogger({
      write: (line: string) => lines.push(line)
    });

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

  it("drops a field it does not know, and names it instead", () => {
    // Break caught: the allowlist silently swallowing a new field would lose
    // telemetry nobody noticed was gone; naming it makes the omission show.
    const marker = "UNIQUE_UNLISTED_FIELD_MARKER_c83e10";
    const lines: string[] = [];
    const logger = createWorkerLogger({
      write: (line: string) => lines.push(line)
    });

    logger.info({
      event: "evidence_job",
      characterName: marker,
      raiderIoCharacterName: marker,
      durationMs: 5
    });

    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(lines[0]).not.toContain(marker);
    expect(record.durationMs).toBe(5);
    expect(record.droppedFields).toEqual([
      "characterName",
      "raiderIoCharacterName"
    ]);
  });

  it("keeps every field of the records the worker writes", () => {
    // Break caught: moving from a denylist to an allowlist drops anything the
    // list forgot. These are the worker's records, field for field.
    const lines: string[] = [];
    const logger = createWorkerLogger({
      write: (line: string) => lines.push(line)
    });
    const records: Record<string, unknown>[] = [
      {
        event: "evidence_job",
        runId: "run-1",
        correlationId: "c1",
        queueWaitMs: 1,
        attempt: 1,
        outcome: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        killCount: 0,
        raiderIoHistoricOutcome: null,
        verifiedKillsSearched: null,
        verifiedKillsSkippedEmpty: null,
        attendanceRecoveredKills: null,
        tierSearchRaidId: null,
        tierSearchOutcome: null,
        tierSearchRecoveredKills: null,
        tierSearchRecoveredWipes: null,
        terminalTierCount: 0,
        requestCapUsed: 80,
        parseRequestCapUsed: 20,
        pointsLimitPerHour: null,
        pointsRemainingBefore: null,
        pointsSpentByRun: null,
        pointsRemainingAfter: null,
        errorName: null,
        errorCode: null,
        retryDecision: null,
        retryReason: null,
        stopDisposition: null,
        limitationQuery: null,
        durationMs: 0,
        // Measurement totals, by every suffix the scope writes.
        warcraftLogsMs: 1,
        warcraftLogsCalls: 1,
        warcraftLogsMaxCallMs: 1,
        warcraftLogsMaxCallName: "getFirstKillReports",
        warcraftLogsHistoryScanRequests: 1,
        warcraftLogsHistoryScanMs: 1,
        warcraftLogsGuildAttendanceLimited: 1,
        warcraftLogsMaxRequestMs: 1,
        warcraftLogsMaxRequestName: "history_scan",
        warcraftLogsHistoricAliasMs: 1,
        raiderIoRankingsRequests: 1,
        raiderIoRankingPhysicalCalls: 1,
        raiderIoRankingLogicalKeys: 1,
        blizzardAchievementsRequests: 1,
        blizzardLimiterWaitMs: 1,
        blizzardMinCallMs: 1,
        blizzardFastCalls: 1,
        blizzardFastCallThresholdMs: 1,
        dbCallMs: 1,
        limiterWaitMs: 1,
        retryAfterMaxMs: 1,
        rateLimitHits: 1,
        runJoined: true,
        warcraftLogsThrottles: 1,
        warcraftLogsRetryAfterMaxMs: 1
      },
      {
        event: "discovery_run",
        runId: "run-2",
        region: "eu",
        realm: "silvermoon",
        name: "ryii",
        attempt: 1,
        outcome: "complete",
        state: "complete",
        limitationCode: null,
        characterCount: 3,
        durationMs: 1,
        correlationId: null,
        queueWaitMs: null,
        fingerprintQueueWaitMs: null,
        fingerprintReservedRequests: 0,
        fingerprintUsedRequests: 0,
        fingerprintDurationMs: 0
      },
      {
        event: "upstream_throttle",
        provider: "blizzard",
        retryAfterMs: 1,
        runId: "run-3"
      },
      {
        event: "evidence_resume_sweep",
        resumed: 1,
        released: 0,
        republished: 0,
        durationMs: 1,
        errorName: "Error"
      },
      {
        event: "applicant_sheet_poll",
        baseline: false,
        rebaselined: false,
        created: 0,
        backlog: 0,
        invalid: 0,
        truncated: 0,
        failures: 0,
        durationMs: 1
      },
      {
        event: "applicant_sheet_drain",
        admitted: 0,
        suppressed: 0,
        deferred: 0,
        durationMs: 1
      },
      {
        event: "evidence_cache_cleanup",
        removedEvidenceRuns: 0,
        removedCollectionStages: 0,
        removedRunCosts: 0,
        durationMs: 1
      },
      {
        event: "maintainer_alert_delivery_failed",
        alertEvent: "applicant_new_intents",
        failure: "http_status",
        status: 500
      },
      {
        event: "fingerprint_reservation_pressure",
        committedRequests: 1,
        hourlyBudget: 1,
        blockedForMs: 1
      },
      { event: "evidence_run_announcement_failed", phase: "started" },
      {
        event: "light_collection_skipped",
        reason: "all_domains_fresh_terminal"
      },
      { event: "worker_stopping", signal: "SIGTERM" },
      { event: "worker_ready", port: 8080 }
    ];

    for (const written of records) logger.info(written);

    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual(
      records.map((written) => ({
        level: 30,
        time: expect.any(Number),
        ...written
      }))
    );
  });
});
