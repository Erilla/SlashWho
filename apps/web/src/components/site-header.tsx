import Link from "next/link";

import { Logo } from "./logo";

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link className="header-logo" href="/" aria-label="Who home">
        <Logo className="header-logo-mark" />
      </Link>
      <nav className="site-nav" aria-label="Site navigation">
        <Link href="/api">API</Link>
        <a href="https://github.com/Erilla/SlashWho">GitHub</a>
      </nav>
    </header>
  );
}
