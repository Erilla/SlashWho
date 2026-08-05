"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="status-page">
      <h1>Unable to load this page</h1>
      <p>Please try again. No private diagnostic details are displayed.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
