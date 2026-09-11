import { Logo } from "./logo";

export function SiteHeader() {
  return (
    <header className="site-header">
      <span className="header-logo" aria-label="Who">
        <Logo className="header-logo-mark" />
      </span>
    </header>
  );
}
