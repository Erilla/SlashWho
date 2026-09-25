import { expect, it } from "vitest";

import {
  buildCuttingEdgeSequence,
  lookupCuttingEdgeAchievement
} from "./cutting-edge-catalogue";

it("looks up a generated Cutting Edge achievement by its official ID", () => {
  expect(lookupCuttingEdgeAchievement("40254")).toMatchObject({
    achievementId: "40254",
    achievementName: "Cutting Edge: Queen Ansurek",
    categoryId: "15271",
    iconUrl: "https://render.worldofwarcraft.com/eu/icons/56/5779391.jpg"
  });
});

it("does not infer achievements absent from the generated catalogue", () => {
  expect(lookupCuttingEdgeAchievement("1")).toBeNull();
});

it("places recorded achievements and missing entries in catalogue order", () => {
  const sequence = buildCuttingEdgeSequence([
    { achievementId: "41625", value: "Dimensius evidence" },
    { achievementId: "40254", value: "Ansurek evidence" }
  ]).map((entry) => ({
    achievementId: entry.achievement.achievementId,
    status: entry.status
  }));
  expect(sequence).toHaveLength(33);
  expect(sequence.slice(4, 7)).toEqual([
    { achievementId: "41625", status: "recorded" },
    { achievementId: "41297", status: "not_recorded" },
    { achievementId: "40254", status: "recorded" }
  ]);

  expect(
    buildCuttingEdgeSequence([
      { achievementId: "unknown" },
      { achievementId: "41625" }
    ]).filter((entry) => entry.status === "not_recorded")
  ).toEqual([]);
  expect(
    buildCuttingEdgeSequence([
      { achievementId: "40254" },
      { achievementId: "unknown" },
      { achievementId: "41625" }
    ]).map((entry) => ({
      achievementId: entry.achievement.achievementId,
      status: entry.status
    }))
  ).toEqual([
    { achievementId: "40254", status: "recorded" },
    { achievementId: "unknown", status: "recorded" },
    { achievementId: "41625", status: "recorded" }
  ]);
});

it("fills the full Cutting Edge catalogue around a single recorded achievement", () => {
  const sequence = buildCuttingEdgeSequence([{ achievementId: "40254" }]);

  expect(sequence).toHaveLength(33);
  expect(sequence[0]).toMatchObject({
    status: "not_recorded",
    achievement: { achievementName: "Cutting Edge: Ula'tek" }
  });
  expect(
    sequence.find((entry) => entry.achievement.achievementId === "40254")
  ).toMatchObject({ status: "recorded" });
  expect(sequence.at(-1)).toMatchObject({
    status: "not_recorded",
    achievement: { achievementName: "Cutting Edge: Will of the Emperor" }
  });
  expect(
    sequence.filter((entry) => entry.status === "not_recorded")
  ).toHaveLength(32);
});

it("shows no Cutting Edge timeline when none are recorded", () => {
  expect(buildCuttingEdgeSequence([])).toEqual([]);
});

it("orders recorded achievements by raid chronology even when completed out of order", () => {
  const sequence = buildCuttingEdgeSequence([
    { achievementId: "7485" },
    { achievementId: "7487" }
  ]);

  expect(
    sequence.slice(-3).map((entry) => ({
      achievementId: entry.achievement.achievementId,
      status: entry.status
    }))
  ).toEqual([
    { achievementId: "7487", status: "recorded" },
    { achievementId: "7486", status: "not_recorded" },
    { achievementId: "7485", status: "recorded" }
  ]);
});

it("uses raid chronology when achievement IDs are not chronological", () => {
  const sequence = buildCuttingEdgeSequence([
    { achievementId: "11191" },
    { achievementId: "11192" }
  ]).map((entry) => ({
    achievementId: entry.achievement.achievementId,
    status: entry.status
  }));
  expect(sequence).toHaveLength(33);
  const firstRecorded = sequence.findIndex(
    (entry) => entry.achievementId === "11192"
  );
  expect(sequence.slice(firstRecorded, firstRecorded + 3)).toEqual([
    { achievementId: "11192", status: "recorded" },
    { achievementId: "11580", status: "not_recorded" },
    { achievementId: "11191", status: "recorded" }
  ]);
});
