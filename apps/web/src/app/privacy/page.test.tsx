// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import PrivacyPage from "./page";

it("states the fingerprint reach without publishing a discovery method", () => {
  // Break caught: the page previously promised that privacy-hidden Raider.IO
  // ownership was excluded from inferred links. It no longer is, so a page still
  // claiming the exclusion would tell players something untrue about their data.
  render(<PrivacyPage />);

  expect(screen.getByText(/ownership is not shown there/i)).toBeInTheDocument();
  expect(
    screen.getByText(/public alt lists do not disclose the discovery method/i)
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/privacy-hidden Raider\.IO ownership is excluded/i)
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/opt-out/i)).not.toBeInTheDocument();
});
