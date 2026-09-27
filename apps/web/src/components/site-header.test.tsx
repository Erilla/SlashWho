// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
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
vi.mock("./search-form", () => ({
  SearchForm: () => <form aria-label="Character search" />
}));
import { SiteHeader } from "./site-header";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens a menu with signed-out destinations", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ account: null }))
  );
  const user = userEvent.setup();
  const { container } = render(<SiteHeader />);
  expect(container.querySelector(".header-search")).toContainElement(
    screen.getByRole("form", { name: "Character search" })
  );
  const trigger = screen.getByRole("button", { name: "Open menu" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await user.click(trigger);
  const menu = screen.getByRole("navigation", { name: "Primary" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(within(menu).getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/operations/login"
  );
  expect(
    within(menu).getByRole("link", { name: "Create account" })
  ).toHaveAttribute("href", "/account/create");
  expect(within(menu).getByRole("link", { name: "Changelog" })).toHaveAttribute(
    "href",
    "/changelog"
  );
  expect(within(menu).getByRole("link", { name: "Settings" })).toHaveAttribute(
    "href",
    "/settings"
  );
});

it("closes the menu with Escape and outside clicks", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ account: null }))
  );
  const user = userEvent.setup();
  render(
    <>
      <SiteHeader />
      <main>Outside</main>
    </>
  );
  const trigger = screen.getByRole("button", { name: "Open menu" });
  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  await user.click(trigger);
  await user.click(screen.getByText("Outside"));
  expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  await waitFor(() =>
    expect(trigger).toHaveAttribute("aria-expanded", "false")
  );
});

it("publishes its rendered height as the page's header offset", () => {
  // Break caught: the page reserved a fixed height per breakpoint, and a
  // phone header with structured search fields or an error outgrew it.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ account: null }))
  );
  let notifyResize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notifyResize = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
  let height = 112;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ height }) as DOMRect
  );
  const root = document.documentElement;

  const { unmount } = render(<SiteHeader />);
  expect(root.style.getPropertyValue("--header-offset")).toBe("112px");

  height = 260;
  notifyResize();
  expect(root.style.getPropertyValue("--header-offset")).toBe("260px");

  unmount();
  expect(root.style.getPropertyValue("--header-offset")).toBe("");
});
