import { expect, it } from "vitest";

import { dossierPath } from "./dossier-path";

it("builds the canonical dossier path for a character key", () => {
  expect(
    dossierPath({ region: "eu", realm: "tarren-mill", name: "ryii" })
  ).toBe("/dossiers/eu/tarren-mill/ryii");
});

it("encodes a name outside ASCII", () => {
  expect(dossierPath({ region: "eu", realm: "silvermoon", name: "rÿii" })).toBe(
    "/dossiers/eu/silvermoon/r%C3%BFii"
  );
});
