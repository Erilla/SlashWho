import Link from "next/link";

export default function NotFound() {
  return (
    <main className="status-page">
      <h1>Character not found</h1>
      <p>The character or refresh you requested is not available.</p>
      <Link href="/">Search again</Link>
    </main>
  );
}
