import { Logo } from "../components/logo";

export default function Home() {
  return (
    <main className="home-shell">
      <section className="home-search" aria-labelledby="home-title">
        <h1 id="home-title" className="wordmark">
          <Logo className="wordmark-mark" />
          <span>Who</span>
        </h1>
        <p className="home-introduction">
          Research a World of Warcraft applicant from a Raider.IO or Warcraft
          Logs character URL, or by character name and realm.
        </p>
      </section>
    </main>
  );
}
