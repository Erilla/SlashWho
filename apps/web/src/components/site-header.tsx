import Link from "next/link";
import { SearchForm } from "./search-form";
import { Logo } from "./logo";
import { AccountNavigation } from "./account-navigation";

export const headerIdentitySlotId = "site-header-identity";

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link href="/" className="header-logo" aria-label="SlashWho home">
        <Logo className="header-logo-mark" />
      </Link>
      <nav aria-label="Primary" className="site-nav">
        <Link href="/changelog" className="site-nav-link">
          Changelog
        </Link>
        <Link href="/settings" className="site-nav-link">
          Settings
        </Link>
        <AccountNavigation signInSlotId="header-sign-in" />
      </nav>
      <div className="header-identity" id={headerIdentitySlotId} />
      <div className="header-search">
        <SearchForm />
        <div id="header-sign-in" />
      </div>
    </header>
  );
}
