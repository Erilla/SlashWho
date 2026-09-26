import { Logo } from "../components/logo";
import { RecentDossierSearches } from "../components/recent-dossier-searches";

export default function Home() {
  return (
    <main className="home-shell">
      <section className="home-search" aria-labelledby="home-title">
        <h1 id="home-title" className="wordmark">
          <Logo className="wordmark-mark" />
          <span>Who</span>
        </h1>
        <RecentDossierSearches />
      </section>
    </main>
  );
}
