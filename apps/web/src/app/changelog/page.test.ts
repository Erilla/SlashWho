import { expect, it } from "vitest";

import * as changelogPage from "./page";

it("renders at request time so runtime changelog configuration is available", () => {
  expect(changelogPage.dynamic).toBe("force-dynamic");
});
