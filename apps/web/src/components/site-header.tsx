"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { SearchForm } from "./search-form";
import { Logo } from "./logo";
import { AccountNavigation } from "./account-navigation";

export const headerIdentitySlotId = "site-header-identity";

/* The page clears the fixed header by --header-offset. Its stylesheet value is
   only an estimate per breakpoint, and the header grows past it whenever the
   search form shows structured fields or an error, so the rendered height is
   published instead. It is kept apart from --header-height, which is the
   header's own min-height, so a header that grew once can shrink again. */
export const headerOffsetProperty = "--header-offset";

export function SiteHeader() {
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const header = headerRef.current;
    if (!header || typeof ResizeObserver !== "function") return;

    const root = document.documentElement;
    const publishOffset = () => {
      root.style.setProperty(
        headerOffsetProperty,
        `${header.getBoundingClientRect().height}px`
      );
    };
    const resizeObserver = new ResizeObserver(publishOffset);

    publishOffset();
    resizeObserver.observe(header);

    return () => {
      resizeObserver.disconnect();
      root.style.removeProperty(headerOffsetProperty);
    };
  }, []);

  return (
    <header className="site-header" ref={headerRef}>
      <Link href="/" className="header-logo" aria-label="SlashWho home">
        <Logo className="header-logo-mark" />
      </Link>
      <div className="header-search">
        <SearchForm />
      </div>
      <div className="header-identity" id={headerIdentitySlotId} />
      <AccountNavigation />
    </header>
  );
}
