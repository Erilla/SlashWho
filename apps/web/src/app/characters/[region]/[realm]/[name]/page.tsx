import { parseRaiderIoCharacterUrl, toCharacterPath } from "@slashwho/domain";
import { notFound, permanentRedirect } from "next/navigation";

import { getContainer } from "../../../../../server/container";
import { CharacterPageClient } from "./character-page-client";

export const dynamic = "force-dynamic";

type CharacterPageProps = Readonly<{
  params: Promise<{ region: string; realm: string; name: string }>;
  searchParams: Promise<{ job?: string | string[] }>;
}>;

function parseRoute(params: { region: string; realm: string; name: string }) {
  try {
    return parseRaiderIoCharacterUrl(
      `https://raider.io/characters/${encodeURIComponent(params.region)}/${encodeURIComponent(params.realm)}/${encodeURIComponent(params.name)}`
    );
  } catch {
    notFound();
  }
}

export default async function CharacterPage({
  params,
  searchParams
}: CharacterPageProps) {
  const raw = await params;
  const identity = parseRoute(raw);
  const canonicalPath = toCharacterPath(identity);
  if (`/characters/${raw.region}/${raw.realm}/${raw.name}` !== canonicalPath) {
    permanentRedirect(canonicalPath);
  }

  const { searches } = await getContainer();
  const resource = await searches.getCurrent(identity);
  const history = resource
    ? await searches.getHistory(identity)
    : { items: [], nextCursor: null };
  const jobParam = (await searchParams).job;
  const jobId = typeof jobParam === "string" ? jobParam : null;
  const job =
    jobId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      jobId
    )
      ? await searches.getRun(jobId)
      : null;
  const matchingJob = job?.characterUrl === canonicalPath ? job : null;

  if (!resource && !matchingJob) notFound();

  return (
    <CharacterPageClient
      identity={identity}
      initialResource={resource}
      initialHistory={history ?? { items: [], nextCursor: null }}
      initialJob={matchingJob}
      selectedSnapshotId={null}
    />
  );
}
