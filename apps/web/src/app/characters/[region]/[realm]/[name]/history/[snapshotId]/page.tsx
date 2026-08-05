import type { CharacterResource } from "@slashwho/contracts";
import { parseRaiderIoCharacterUrl, toCharacterPath } from "@slashwho/domain";
import { notFound, permanentRedirect } from "next/navigation";

import { getContainer } from "../../../../../../../server/container";
import { CharacterPageClient } from "../../character-page-client";

export const dynamic = "force-dynamic";

type HistoricalPageProps = Readonly<{
  params: Promise<{
    region: string;
    realm: string;
    name: string;
    snapshotId: string;
  }>;
}>;

export default async function HistoricalPage({ params }: HistoricalPageProps) {
  const raw = await params;
  let identity;
  try {
    identity = parseRaiderIoCharacterUrl(
      `https://raider.io/characters/${encodeURIComponent(raw.region)}/${encodeURIComponent(raw.realm)}/${encodeURIComponent(raw.name)}`
    );
  } catch {
    notFound();
  }
  const canonicalPath = toCharacterPath(identity);
  const canonicalSnapshotPath = `${canonicalPath}/history/${raw.snapshotId}`;
  if (
    `/characters/${raw.region}/${raw.realm}/${raw.name}/history/${raw.snapshotId}` !==
    canonicalSnapshotPath
  ) {
    permanentRedirect(canonicalSnapshotPath);
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      raw.snapshotId
    )
  ) {
    notFound();
  }

  const { searches } = await getContainer();
  const [snapshot, history] = await Promise.all([
    searches.getSnapshot(identity, raw.snapshotId),
    searches.getHistory(identity)
  ]);
  if (!snapshot || !history) notFound();

  const resource: CharacterResource = {
    character: snapshot.root,
    snapshot: {
      id: snapshot.id,
      refreshedAt: snapshot.refreshedAt,
      state: snapshot.state,
      characterCount: snapshot.characters.length,
      characters: snapshot.characters
    },
    activeJob: null
  };

  return (
    <CharacterPageClient
      identity={identity}
      initialResource={resource}
      initialHistory={history}
      initialJob={null}
      selectedSnapshotId={snapshot.id}
    />
  );
}
