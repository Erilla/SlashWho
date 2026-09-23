import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { loadWebConfig } from "../../../server/config";
import { getContainer } from "../../../server/container";
import { authorizes } from "../../../server/operator-auth";

import { CollectionMonitorClient } from "./collection-monitor-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Collection monitor",
  robots: { index: false, follow: false }
};

export default async function CollectionMonitorPage() {
  // The page proxy applies renewal/expiry cookies to the navigation response.
  // Recheck here before reading data; never trust a client-supplied principal.
  const { collectionMonitor, accountAuth } = await getContainer();
  const authentication = await accountAuth.authenticate(
    new Request(
      new URL(
        "/operations/collection-monitor",
        loadWebConfig().operatorAuth.origin
      ),
      { headers: await headers() }
    )
  );
  if (!authorizes(authentication.principal, "admin")) {
    redirect("/operations/login");
  }
  return (
    <CollectionMonitorClient initialMonitor={await collectionMonitor.list()} />
  );
}
