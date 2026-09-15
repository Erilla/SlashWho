import { applicantDossierSchema, type CharacterKey } from "@slashwho/contracts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DossierPageClient } from "../dossiers/[region]/[realm]/[name]/dossier-page-client";
import capturedDossier from "./ryii-dossier.json";

/**
 * A frozen dossier for showing the applicant view without touching the API.
 * Refresh the capture with `pnpm capture:demo-dossier`.
 */

const demoIdentity: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "ryii"
};

export const metadata: Metadata = {
  title: "Demo applicant dossier"
};

export default function DemoPage() {
  const parsed = applicantDossierSchema.safeParse(capturedDossier as unknown);
  if (!parsed.success) notFound();

  return (
    <DossierPageClient
      canAddCharacters={false}
      identity={demoIdentity}
      initialDossier={parsed.data}
      jobId={null}
    />
  );
}
