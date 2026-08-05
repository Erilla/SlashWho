import { expect, it, vi } from "vitest";

let ready = true;
vi.mock("../../server/container", () => ({
  getContainer: async () => ({ ready: async () => ready })
}));

import { GET } from "./route";

it("reports database readiness without exposing configuration", async () => {
  // Break caught: Railway could route traffic before migrations/database are usable.
  let response = await GET();
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: "ready" });

  ready = false;
  response = await GET();
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({ status: "not_ready" });
});
