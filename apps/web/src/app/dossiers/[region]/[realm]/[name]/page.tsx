import { parseApplicantCharacterUrl } from "@slashwho/domain";
import { notFound, permanentRedirect } from "next/navigation";

import { DossierPageClient } from "./dossier-page-client";

type DossierPageProps = Readonly<{
  params: Promise<{ region: string; realm: string; name: string }>;
  searchParams: Promise<{ job?: string | string[] }>;
}>;

function parseRoute(params: { region: string; realm: string; name: string }) {
  try {
    return parseApplicantCharacterUrl(
      `https://www.warcraftlogs.com/character/${encodeURIComponent(params.region)}/${encodeURIComponent(params.realm)}/${encodeURIComponent(params.name)}`
    );
  } catch {
    notFound();
  }
}

export default async function DossierPage({
  params,
  searchParams
}: DossierPageProps) {
  const raw = await params;
  const identity = parseRoute(raw);
  const jobParam = (await searchParams).job;
  const jobId = typeof jobParam === "string" ? jobParam : null;
  const canonicalPath = `/dossiers/${identity.region}/${identity.realm}/${identity.name}`;

  if (`/dossiers/${raw.region}/${raw.realm}/${raw.name}` !== canonicalPath) {
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
