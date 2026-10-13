import { describe, expect, it } from "vitest";
import { evidenceRunProgressResponseSchema } from "@slashwho/contracts";
import { evidenceRunProgressView } from "./applicant-dossier-service";

const key = { region: "eu", realm: "silvermoon", name: "ryun" } as const;
const id = "10000000-0000-4000-8000-000000000013";

describe("progress row projection", () => {
  it("carries the owning identity and ordered phase limitations through the contract", () => {
    const result = evidenceRunProgressView({
      id,
      key,
      status: "running",
      deferred: false,
      phases: [
        {
          id: "warcraft_logs_history",
          state: "limited",
          limitationCode: "rate_limited"
        },
        { id: "publication", state: "pending", limitationCode: null }
      ]
    });
    expect(result).toMatchObject({
      key,
      evidenceState: "scanning",
      collectionProgress: [
        {
          id: "warcraft_logs_history",
          state: "limited",
          limitationCode: "rate_limited"
        },
        { id: "publication", state: "pending" }
      ]
    });
    expect(
      evidenceRunProgressResponseSchema.parse({ runs: [result] }).runs
    ).toEqual([result]);
  });

  it.each([
    ["queued", "waiting"],
    ["retrying", "waiting"],
    ["running", "scanning"],
    ["complete", "complete"],
    ["partial", "partial"],
    ["failed", "partial"]
  ] as const)(
    "derives %s evidence state and permits uninitialised phases",
    (status, evidenceState) => {
      expect(
        evidenceRunProgressView({
          id,
          key,
          status,
          deferred: false,
          phases: []
        })
      ).toMatchObject({ key, evidenceState, collectionProgress: [] });
    }
  );

  it("moves the version when only a phase limitation changes", () => {
    const progress = {
      id,
      key,
      status: "running" as const,
      deferred: false,
      phases: [
        {
          id: "warcraft_logs_history",
          state: "limited" as const,
          limitationCode: "rate_limited"
        }
      ]
    };
    expect(evidenceRunProgressView(progress).version).not.toBe(
      evidenceRunProgressView({
        ...progress,
        phases: [{ ...progress.phases[0]!, limitationCode: "request_cap" }]
      }).version
    );
  });

  it("rejects progress without the fields a row patch needs", () => {
    expect(
      evidenceRunProgressResponseSchema.safeParse({
        runs: [{ id, state: "running", version: "v" }]
      }).success
    ).toBe(false);
  });
});
