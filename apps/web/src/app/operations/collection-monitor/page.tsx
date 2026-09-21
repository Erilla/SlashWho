import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { loadWebConfig } from "../../../server/config";
import { getContainer } from "../../../server/container";
import { isOperatorRequest } from "../../../server/operator-session";

import { CollectionMonitorClient } from "./collection-monitor-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Collection monitor",
  robots: { index: false, follow: false }
};

export default async function CollectionMonitorPage() {
  if (!isOperatorRequest(await headers(), loadWebConfig().application)) {
    redirect("/operations/login");
  }
  const { collectionMonitor } = await getContainer();
  return (
    <CollectionMonitorClient initialMonitor={await collectionMonitor.list()} />
  );
}
