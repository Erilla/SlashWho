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
      <div className="header-search">
        <SearchForm />
      </div>
      <div className="header-identity" id={headerIdentitySlotId} />
      <AccountNavigation />
    </header>
  );
}
