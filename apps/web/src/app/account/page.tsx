import Link from "next/link";
export default function Page() {
  return (
    <main className="page-shell">
      <h1>Account</h1>
      <nav aria-label="Account settings">
        <ul>
          <li>
            <Link href="/settings">Key settings</Link>
          </li>
          <li>
            <Link href="/account/change-password">Change password</Link>
          </li>
          <li>
            <Link href="/account/email">Change email</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
