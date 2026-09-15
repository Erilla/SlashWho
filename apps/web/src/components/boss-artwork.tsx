"use client";

import { useState } from "react";

import { DossierMediaFallback } from "./dossier-media-fallback";

// Blizzard renders every boss at 112px square in the Journal, so the artwork
// is requested and reserved at that size rather than scaled up from a thumbnail.
const artworkSize = 112;

type BossArtworkProps = Readonly<{
  bossName: string;
  imageUrl: string | null;
}>;

export function BossArtwork({ bossName, imageUrl }: BossArtworkProps) {
  const [failed, setFailed] = useState(false);
  const alt = `${bossName} artwork`;

  return imageUrl && !failed ? (
    <img
      alt={alt}
      className="dossier-boss-artwork"
      decoding="async"
      height={artworkSize}
      loading="lazy"
      onError={() => {
        setFailed(true);
      }}
      src={imageUrl}
      width={artworkSize}
    />
  ) : (
    <DossierMediaFallback alt={alt} className="dossier-boss-artwork" />
  );
}
