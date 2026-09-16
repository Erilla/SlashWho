import type { Metadata } from "next";
import { parseCharacterRoute } from "../../../../../server/http";
import { notFound, permanentRedirect } from "next/navigation";

import { dossierTitle } from "../../../../../lib/dossier-title";
import { DossierPageClient } from "./dossier-page-client";

type DossierPageProps = Readonly<{
  params: Promise<{ region: string; realm: string; name: string }>;
  searchParams: Promise<{ job?: string | string[] }>;
}>;

function parseRoute(params: { region: string; realm: string; name: string }) {
  try {
    return parseCharacterRoute(params);
  } catch {
    notFound();
  }
}

/**
 * The guild is not known here: a dossier loads client-side, and fetching it
 * server-side just to title the tab would cost a request on every view. The
 * character and realm are in the route, so the tab is correct immediately and
 * the client adds the guild once the dossier arrives.
 */
export async function generateMetadata({
  params
}: Pick<DossierPageProps, "params">): Promise<Metadata> {
  const parsed = parseRoute(await params);
  return { title: dossierTitle(parsed.key, null) };
}

export default async function DossierPage({
  params,
  searchParams
}: DossierPageProps) {
  const raw = await params;
  const parsed = parseRoute(raw);
  const identity = parsed.key;
  const jobParam = (await searchParams).job;
  const jobId = typeof jobParam === "string" ? jobParam : null;
  const canonicalPath = `/dossiers/${identity.region}/${identity.realm}/${identity.name}`;

  if (!parsed.canonical) {
    permanentRedirect(jobId ? `${canonicalPath}?job=${jobId}` : canonicalPath);
  }

  return (
    <DossierPageClient
      identity={identity}
      initialDossier={null}
      jobId={jobId}
    />
  );
}
