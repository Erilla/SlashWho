import { describe, expect, it, vi } from "vitest";

const permanentRedirect = vi.hoisted(() =>
  vi.fn((destination: string): never => {
    throw new Error(`redirect:${destination}`);
  })
);

vi.mock("next/navigation", () => ({
  notFound: vi.fn((): never => {
    throw new Error("not_found");
  }),
  permanentRedirect
}));

vi.mock("../../../../../server/container", () => ({
  getContainer: vi.fn()
}));

import CharacterPage from "./page";

describe("CharacterPage canonical redirects", () => {
  it("preserves a valid job query while redirecting mixed-case paths", async () => {
    await expect(
      CharacterPage({
        params: Promise.resolve({
          region: "EU",
          realm: "Silvermoon",
          name: "Ryii"
        }),
        searchParams: Promise.resolve({
          job: "ca3ccfdf-1e8b-49b1-9729-459f42a104c0"
        })
      })
    ).rejects.toThrow(
      "redirect:/characters/eu/silvermoon/ryii?job=ca3ccfdf-1e8b-49b1-9729-459f42a104c0"
    );
    expect(permanentRedirect).toHaveBeenCalledWith(
      "/characters/eu/silvermoon/ryii?job=ca3ccfdf-1e8b-49b1-9729-459f42a104c0"
    );
  });
});
