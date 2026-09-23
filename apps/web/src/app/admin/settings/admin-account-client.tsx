"use client";

import { useRef, useState } from "react";

type Summary = {
  id: string;
  email: string;
  role: "user" | "admin";
  active: boolean;
  verifiedAt: string | null;
  createdAt: string;
};
type Action =
  | { action: "role"; role: Summary["role"] }
  | { action: "active"; active: boolean }
  | { action: "require_password_change" };

export function AdminAccountClient({
  initialAccounts
}: {
  initialAccounts: Summary[];
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const result = useRef<HTMLParagraphElement>(null);

  async function update(account: Summary, action: Action) {
    const description =
      action.action === "role"
        ? `change ${account.email}'s role to ${action.role}`
        : action.action === "active"
          ? `${action.active ? "reactivate" : "disable"} ${account.email}`
          : `require ${account.email} to change their password`;
    if (!window.confirm(`Are you sure you want to ${description}?`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/accounts/${account.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action)
      });
      if (response.ok) {
        const listed = await fetch("/api/admin/accounts", {
          cache: "no-store"
        });
        if (!listed.ok) throw new Error("Could not refresh accounts.");
        setAccounts((await listed.json()) as Summary[]);
        setMessage(`${account.email} updated.`);
      } else {
        setMessage(
          response.status === 409
            ? "The last active admin cannot be demoted or disabled."
            : `Could not update ${account.email}.`
        );
      }
    } catch {
      setMessage(`Could not update ${account.email}.`);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => result.current?.focus());
    }
  }

  return (
    <main className="page-shell">
      <h1>Admin settings</h1>
      <p>Manage account access and password change requirements.</p>
      <p ref={result} tabIndex={-1} role="status" aria-live="polite">
        {message}
      </p>
      <div className="collection-monitor-table-scroll">
        <table>
          <caption>Accounts</caption>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Verified</th>
              <th scope="col">Created</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <th scope="row">{account.email}</th>
                <td>{account.role}</td>
                <td>{account.active ? "Active" : "Disabled"}</td>
                <td>{account.verifiedAt ? "Verified" : "Unverified"}</td>
                <td>{new Date(account.createdAt).toLocaleDateString()}</td>
                <td>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      update(account, {
                        action: "role",
                        role: account.role === "admin" ? "user" : "admin"
                      })
                    }
                  >
                    {account.role === "admin" ? "Make user" : "Make admin"}
                  </button>{" "}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      update(account, {
                        action: "active",
                        active: !account.active
                      })
                    }
                  >
                    {account.active ? "Disable" : "Reactivate"}
                  </button>{" "}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      update(account, { action: "require_password_change" })
                    }
                  >
                    Require password change
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
