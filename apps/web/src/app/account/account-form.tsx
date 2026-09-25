"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { notifyAccountSessionChanged } from "../../lib/account-session-events";

export type Flow =
  | "create"
  | "verify"
  | "resend"
  | "recover"
  | "reset"
  | "change-password"
  | "change-email"
  | "confirm-email";

const flows: Record<
  Flow,
  {
    title: string;
    endpoint: string;
    button: string;
    fields: readonly (
      "email" | "password" | "currentPassword" | "newPassword" | "newEmail"
    )[];
  }
> = {
  create: {
    title: "Create account",
    endpoint: "register",
    button: "Create account",
    fields: ["email", "password"]
  },
  verify: {
    title: "Verify email",
    endpoint: "verify",
    button: "Verify email",
    fields: ["password"]
  },
  resend: {
    title: "Resend verification",
    endpoint: "verification-resend",
    button: "Send verification link",
    fields: ["email"]
  },
  recover: {
    title: "Recover account",
    endpoint: "recovery",
    button: "Send recovery link",
    fields: ["email"]
  },
  reset: {
    title: "Reset password",
    endpoint: "password",
    button: "Reset password",
    fields: ["newPassword"]
  },
  "change-password": {
    title: "Change password",
    endpoint: "password",
    button: "Change password",
    fields: ["currentPassword", "newPassword"]
  },
  "change-email": {
    title: "Change email",
    endpoint: "email",
    button: "Request email change",
    fields: ["password", "newEmail"]
  },
  "confirm-email": {
    title: "Confirm email change",
    endpoint: "email",
    button: "Confirm email change",
    fields: []
  }
};
const labels = {
  email: "Email address",
  password: "Password",
  currentPassword: "Current password",
  newPassword: "New password",
  newEmail: "New email address"
};

export function AccountForm({ flow }: { flow: Flow }) {
  const router = useRouter();
  const params = useSearchParams();
  const actualFlow =
    flow === "verify" && !params.get("token")
      ? "resend"
      : flow === "change-email" && params.get("token")
        ? "confirm-email"
        : flow;
  const config = flows[actualFlow];
  const [values, setValues] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (flow === "change-password") passwordRef.current?.focus();
  }, [flow]);
  useEffect(() => {
    if (feedback) statusRef.current?.focus();
  }, [feedback]);
  const token = params.get("token");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFeedback("");
    const body = { ...values, ...(token ? { token } : {}) };
    setValues((previous) => ({
      ...previous,
      password: "",
      currentPassword: "",
      newPassword: ""
    }));
    try {
      const response = await fetch(`/api/account/${config.endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = (await response.json()) as { message?: string };
      setFeedback(result.message ?? "The request could not be completed.");
      if (response.ok && actualFlow === "verify") {
        notifyAccountSessionChanged();
        router.replace("/account");
        router.refresh();
        return;
      }
      if (
        response.ok &&
        ["reset", "change-password", "confirm-email"].includes(actualFlow)
      )
        notifyAccountSessionChanged();
      if (response.ok && (flow === "reset" || flow === "change-password"))
        router.refresh();
    } catch {
      setFeedback("The request could not be completed. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="page-shell operator-login-page">
      <div>
        <h1>{config.title}</h1>
        {flow === "create" && (
          <p>Enter your email address and choose a password to get started.</p>
        )}
        {flow === "change-password" && (
          <p>After changing your password, sign in again.</p>
        )}
      </div>
      <div className="operator-login-form">
        {!token &&
        (actualFlow === "verify" ||
          actualFlow === "reset" ||
          actualFlow === "confirm-email") ? (
          <p role="alert">This link is missing a token.</p>
        ) : (
          <form className="account-form-fields" onSubmit={submit}>
            {config.fields.map((field) => (
              <div key={field} className="account-form-field">
                <label htmlFor={`account-${field}`}>{labels[field]}</label>
                <input
                  id={`account-${field}`}
                  ref={
                    field === "newPassword" && flow === "change-password"
                      ? passwordRef
                      : undefined
                  }
                  name={field}
                  type={
                    field === "email" || field === "newEmail"
                      ? "email"
                      : "password"
                  }
                  autoComplete={
                    field === "email"
                      ? "email"
                      : field === "newEmail"
                        ? "email"
                        : field === "currentPassword"
                          ? "current-password"
                          : field === "newPassword"
                            ? "new-password"
                            : flow === "create"
                              ? "new-password"
                              : "current-password"
                  }
                  required
                  minLength={
                    field.toLowerCase().includes("password") ? 6 : undefined
                  }
                  value={values[field] ?? ""}
                  onChange={(event) =>
                    setValues((previous) => ({
                      ...previous,
                      [field]: event.target.value
                    }))
                  }
                />
              </div>
            ))}
            <button className="search-button" type="submit" disabled={pending}>
              {pending ? "Please wait…" : config.button}
            </button>
          </form>
        )}
        <p
          className="account-form-status"
          role="status"
          tabIndex={-1}
          ref={statusRef}
        >
          {feedback}
        </p>
        <nav className="account-form-links" aria-label="Account links">
          <Link href="/operations/login">Sign in</Link> ·{" "}
          {flow !== "create" && (
            <>
              <Link href="/account/create">Create account</Link> ·{" "}
            </>
          )}
          <Link href="/account/recover">Forgot password?</Link> ·{" "}
          <Link href="/account/verify">Resend verification</Link>
        </nav>
      </div>
    </main>
  );
}
