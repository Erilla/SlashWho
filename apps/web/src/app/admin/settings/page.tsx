import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getContainer } from "../../../server/container";
import { authorizes } from "../../../server/operator-auth";
import { AdminAccountClient } from "./admin-account-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Account Management",
  robots: { index: false, follow: false }
};

export default async function AdminSettingsPage() {
  const { accountAuth, accountAdmin, accountOrigin } = await getContainer();
  const authentication = await accountAuth.authenticate(
    new Request(new URL("/admin/settings", accountOrigin), {
      headers: await headers()
    })
  );
  if (
    !authorizes(authentication.principal, "admin") ||
    authentication.principal?.kind !== "account"
  )
    redirect("/operations/login");
  const accounts = await accountAdmin.listAccounts(
    authentication.principal.accountId
  );
  return (
    <AdminAccountClient
      initialAccounts={accounts.map(
        ({ id, email, role, active, verifiedAt, createdAt }) => ({
          id,
          email,
          role,
          active,
          verifiedAt: verifiedAt?.toISOString() ?? null,
          createdAt: createdAt.toISOString()
        })
      )}
    />
  );
}
