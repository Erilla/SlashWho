import { expect, it } from "vitest";
import { createDossierRequestSchema } from "./dossier";

it("accepts a page start while retaining strict field validation", () => {
  const characterUrl = "https://raider.io/characters/eu/silvermoon/ryii";
  expect(
    createDossierRequestSchema.safeParse({ characterUrl, startedFrom: "page" })
      .success
  ).toBe(true);
  expect(createDossierRequestSchema.safeParse({ characterUrl }).success).toBe(
    true
  );
  expect(
    createDossierRequestSchema.safeParse({ characterUrl, origin: "page" })
      .success
  ).toBe(false);
});
