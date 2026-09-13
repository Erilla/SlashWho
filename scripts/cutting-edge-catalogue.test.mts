import { describe, expect, it } from "vitest";

import { fetchCuttingEdgeAchievements } from "./cutting-edge-catalogue.mts";

function options(parentCategoryId = 81) {
  const fetch = async (input: string | URL) => {
    const url = new URL(String(input));
    const body =
      url.pathname === "/data/wow/achievement-category/81"
        ? {
            id: 81,
            name: "Feats of Strength",
            subcategories: [
              {
                id: 15271,
                name: "Raids",
                key: {
                  href: "https://api.example/data/wow/achievement-category/15271"
                }
              }
            ]
          }
        : url.pathname === "/data/wow/achievement-category/15271"
          ? {
              id: 15271,
              name: "Raids",
              parent_category: { id: parentCategoryId },
              achievements: [
                { id: 40254, name: "Cutting Edge: Queen Ansurek" },
                { id: 40254, name: "Cutting Edge: Queen Ansurek" },
                { id: 41297, name: "Cutting Edge: Chrome King Gallywix" },
                { id: 1, name: "Ahead of the Curve: Queen Ansurek" },
                { id: 2, name: "Glory of the Nerub-ar Raider" }
              ]
            }
          : url.pathname === "/data/wow/achievement/40254"
            ? {
                id: 40254,
                name: "Cutting Edge: Queen Ansurek",
                description:
                  "Defeat Queen Ansurek in Nerub-ar Palace on Mythic Difficulty before the release of the next raid tier.",
                category: { id: 15271 }
              }
            : url.pathname === "/data/wow/media/achievement/40254"
              ? {
                  assets: [
                    {
                      key: "icon",
                      value: "https://render.example/icon.jpg"
                    }
                  ]
                }
              : url.pathname === "/data/wow/achievement/41297"
                ? {
                    id: 41297,
                    name: "Cutting Edge: Chrome King Gallywix",
                    description:
                      "Defeat Chrome King Gallywix in the Liberation of Undermine on Mythic Difficulty before the release of the next raid tier.",
                    category: { id: 15271 }
                  }
                : url.pathname === "/data/wow/media/achievement/41297"
                  ? { assets: [] }
                  : null;
    return body === null
      ? new Response(null, { status: 404 })
      : Response.json(body);
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    accessToken: "token",
    baseUrl: new URL("https://api.example")
  };
}

describe("Blizzard Cutting Edge catalogue", () => {
  it("keeps only unique Feats of Strength Raid achievements whose names begin Cutting Edge:", async () => {
    await expect(fetchCuttingEdgeAchievements(options())).resolves.toEqual([
      {
        achievementId: "40254",
        achievementName: "Cutting Edge: Queen Ansurek",
        description:
          "Defeat Queen Ansurek in Nerub-ar Palace on Mythic Difficulty before the release of the next raid tier.",
        iconUrl: "https://render.example/icon.jpg",
        categoryId: "15271"
      },
      {
        achievementId: "41297",
        achievementName: "Cutting Edge: Chrome King Gallywix",
        description:
          "Defeat Chrome King Gallywix in the Liberation of Undermine on Mythic Difficulty before the release of the next raid tier.",
        iconUrl: null,
        categoryId: "15271"
      }
    ]);
  });

  it("includes the official achievement icon for Cutting Edge achievements", async () => {
    await expect(
      fetchCuttingEdgeAchievements(options())
    ).resolves.toContainEqual(
      expect.objectContaining({
        achievementId: "40254",
        iconUrl: "https://render.example/icon.jpg"
      })
    );
  });

  it("keeps an achievement icon null when Blizzard has no icon asset", async () => {
    await expect(
      fetchCuttingEdgeAchievements(options())
    ).resolves.toContainEqual(
      expect.objectContaining({
        achievementId: "41297",
        iconUrl: null
      })
    );
  });

  it("rejects a Raids category that is not a Feats of Strength child", async () => {
    await expect(fetchCuttingEdgeAchievements(options(1))).rejects.toThrow(
      "cutting_edge_category_parent_invalid"
    );
  });
});
