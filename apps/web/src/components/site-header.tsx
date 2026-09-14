import Link from "next/link";

import { Logo } from "./logo";

export function SiteHeader() {
  return (
    <header className="site-header">
      <Link href="/" className="header-logo" aria-label="SlashWho home">
        <Logo className="header-logo-mark" />
      </Link>
    </header>
  );
}
