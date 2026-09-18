import { describe, expect, it } from "vitest";

import {
  classifyEvidenceFailure,
  evidenceRetryDecision,
  type EvidenceRetryInput
} from "./evidence-retry-policy";

const notAborted = { aborted: false };

function decisionInput(
  overrides: Partial<EvidenceRetryInput> = {}
): EvidenceRetryInput {
  return {
    classification: "unclassified",
    attempt: 1,
    maxAttempts: 5,
    pointsSpent: 0,
    collectionBegan: false,
    costCeiling: 250,
    ...overrides
  };
}

describe("classifyEvidenceFailure", () => {
  it("reads an abort as cancelled whatever was thrown", () => {
    expect(
      classifyEvidenceFailure(new RangeError("boom"), { aborted: true })
    ).toBe("cancelled");
  });

  it("recognises the points-budget refusal by its code", () => {
    const refusal = Object.assign(new Error("evidence_points_budget_low"), {
      code: "points_budget_low"
    });
    expect(classifyEvidenceFailure(refusal, notAborted)).toBe(
      "points_budget_refusal"
    );
  });

  it("treats a constraint violation as deterministic", () => {
    const violation = Object.assign(new Error("duplicate key"), {
      code: "23505"
    });
    expect(classifyEvidenceFailure(violation, notAborted)).toBe(
      "deterministic"
    );
  });

  it("treats a connection-class SQLSTATE as transient", () => {
    const shutdown = Object.assign(new Error("terminating connection"), {
      code: "57P01"
    });
    expect(classifyEvidenceFailure(shutdown, notAborted)).toBe("transient");
  });

  it("treats a socket errno as transient", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET"
    });
    expect(classifyEvidenceFailure(reset, notAborted)).toBe("transient");
  });

  it("treats a thrown RangeError as deterministic", () => {
    expect(
      classifyEvidenceFailure(
        new RangeError("character_evidence_publication_invalid"),
        notAborted
      )
    ).toBe("deterministic");
  });

  it("treats one of our own authored codes as deterministic", () => {
    expect(
      classifyEvidenceFailure(
        new Error("character_evidence_run_not_active"),
        notAborted
      )
    ).toBe("deterministic");
  });

  it("leaves an unrecognised error unclassified", () => {
    expect(
      classifyEvidenceFailure(new Error("upstream said no"), notAborted)
    ).toBe("unclassified");
  });

  it("leaves a non-error unclassified rather than throwing", () => {
    expect(classifyEvidenceFailure("nope", notAborted)).toBe("unclassified");
    expect(classifyEvidenceFailure(null, notAborted)).toBe("unclassified");
  });
});

describe("evidenceRetryDecision", () => {
  it("stops a deterministic failure on its first attempt", () => {
    expect(
      evidenceRetryDecision(decisionInput({ classification: "deterministic" }))
    ).toEqual({ action: "stop", reason: "deterministic" });
  });

  it("gives an unclassified failure exactly one more attempt", () => {
    expect(
      evidenceRetryDecision(
        decisionInput({ classification: "unclassified", attempt: 1 })
      )
    ).toEqual({ action: "retry", reason: "retryable" });
    expect(
      evidenceRetryDecision(
        decisionInput({ classification: "unclassified", attempt: 2 })
      )
    ).toEqual({ action: "stop", reason: "unclassified_exhausted" });
  });

  it("retries a transient failure that cost little", () => {
    expect(
      evidenceRetryDecision(
        decisionInput({ classification: "transient", pointsSpent: 12 })
      )
    ).toEqual({ action: "retry", reason: "retryable" });
  });

  it("vetoes a retry of an attempt that already spent the points", () => {
    expect(
      evidenceRetryDecision(
        decisionInput({
          classification: "transient",
          pointsSpent: 2_523.24,
          collectionBegan: true
        })
      )
    ).toEqual({ action: "stop", reason: "cost_veto" });
  });

  it("treats unmeasured spend after collection began as expensive", () => {
    expect(
      evidenceRetryDecision(
        decisionInput({
          classification: "transient",
          pointsSpent: null,
          collectionBegan: true
        })
      )
    ).toEqual({ action: "stop", reason: "cost_veto" });
  });

  it("does not veto unmeasured spend when collection never began", () => {
    expect(
      evidenceRetryDecision(
        decisionInput({
          classification: "transient",
          pointsSpent: null,
          collectionBegan: false
        })
      )
    ).toEqual({ action: "retry", reason: "retryable" });
  });

  it("switches the veto off at a ceiling of zero", () => {
    expect(
      evidenceRetryDecision(
        decisionInput({
          classification: "transient",
          pointsSpent: 9_000,
          collectionBegan: true,
          costCeiling: 0
        })
      )
    ).toEqual({ action: "retry", reason: "retryable" });
  });

  it("retries a points-budget refusal whatever it appears to have cost", () => {
    expect(
      evidenceRetryDecision(
        decisionInput({
          classification: "points_budget_refusal",
          attempt: 4,
          pointsSpent: 9_000,
          collectionBegan: true
        })
      )
    ).toEqual({ action: "retry", reason: "retryable" });
  });

  it("retries a cancelled run so a graceful deploy resumes it", () => {
    expect(
      evidenceRetryDecision(
        decisionInput({
          classification: "cancelled",
          pointsSpent: 2_500,
          collectionBegan: true
        })
      )
    ).toEqual({ action: "retry", reason: "cancelled" });
  });

  it("stops once the queue has no attempt left to schedule", () => {
    expect(
      evidenceRetryDecision(
        decisionInput({
          classification: "transient",
          attempt: 5,
          maxAttempts: 5
        })
      )
    ).toEqual({ action: "stop", reason: "attempts_exhausted" });
  });
});
