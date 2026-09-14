import { expect, it } from "vitest";

import {
  buildBoundedCuttingEdgeSequence,
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

it("preserves recorded order while placing bounded missing achievements", () => {
  expect(
    buildBoundedCuttingEdgeSequence([
      { achievementId: "41625", value: "Dimensius evidence" },
      { achievementId: "40254", value: "Ansurek evidence" }
    ]).map((entry) => ({
      achievementId: entry.achievement.achievementId,
      status: entry.status
    }))
  ).toEqual([
    { achievementId: "41625", status: "recorded" },
    { achievementId: "41297", status: "not_recorded" },
    { achievementId: "40254", status: "recorded" }
  ]);

  expect(
    buildBoundedCuttingEdgeSequence([{ achievementId: "40254" }]).filter(
      (entry) => entry.status === "not_recorded"
    )
  ).toEqual([]);
  expect(
    buildBoundedCuttingEdgeSequence([
      { achievementId: "unknown" },
      { achievementId: "41625" }
    ]).filter((entry) => entry.status === "not_recorded")
  ).toEqual([]);
  expect(
    buildBoundedCuttingEdgeSequence([
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

it("uses raid chronology when achievement IDs are not chronological", () => {
  expect(
    buildBoundedCuttingEdgeSequence([
      { achievementId: "11191" },
      { achievementId: "11192" }
    ]).map((entry) => ({
      achievementId: entry.achievement.achievementId,
      status: entry.status
    }))
  ).toEqual([
    { achievementId: "11191", status: "recorded" },
    { achievementId: "11580", status: "not_recorded" },
    { achievementId: "11192", status: "recorded" }
  ]);
});
