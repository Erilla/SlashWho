// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));
vi.mock("./search-form", () => ({ SearchForm: () => <form /> }));
import { SiteHeader } from "./site-header";

it("exposes account entry points to signed-out visitors", () => {
  render(<SiteHeader />);
  expect(screen.getByRole("link", { name: "Sign in" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Create account" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "Admin settings" })).toBeNull();
});
