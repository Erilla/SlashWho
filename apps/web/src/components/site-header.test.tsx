// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
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
  const { container } = render(<SiteHeader />);
  const search = container.querySelector(".header-search");
  const navigation = screen.getByRole("navigation", { name: "Primary" });
  expect(search).not.toBeNull();
  expect(
    within(search as HTMLElement).getByRole("link", { name: "Sign in" })
  ).toHaveAttribute("href", "/operations/login");
  expect(
    within(navigation).queryByRole("link", { name: "Sign in" })
  ).toBeNull();
  expect(screen.getByRole("link", { name: "Create account" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "Admin settings" })).toBeNull();
});
