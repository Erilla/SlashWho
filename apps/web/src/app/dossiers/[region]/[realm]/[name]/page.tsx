import { parseCharacterRoute } from "../../../../../server/http";
import { notFound, permanentRedirect } from "next/navigation";

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
