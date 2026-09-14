import Link from "next/link";
import { SearchForm } from "./search-form";
import { Logo } from "./logo";

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
      </nav>
      <div className="header-search">
        <SearchForm />
      </div>
    </header>
  );
}
