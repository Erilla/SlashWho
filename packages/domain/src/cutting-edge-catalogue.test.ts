import { expect, it } from "vitest";

import { lookupCuttingEdgeAchievement } from "./cutting-edge-catalogue";

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
