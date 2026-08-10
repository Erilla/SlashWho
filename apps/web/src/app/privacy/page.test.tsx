// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import PrivacyPage from "./page";

it("states the fingerprint privacy boundary without publishing a discovery method", () => {
  // Break caught: public documentation could promise privacy while leaving it
  // unclear that privacy-hidden ownership is excluded from inferred links.
  render(<PrivacyPage />);

  expect(
    screen.getByText(/privacy-hidden Raider\.IO ownership is excluded/i)
  ).toBeInTheDocument();
  expect(
    screen.getByText(/public alt lists do not disclose the discovery method/i)
  ).toBeInTheDocument();
  expect(screen.queryByText(/opt-out/i)).not.toBeInTheDocument();
});
