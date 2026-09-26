import type { CharacterKey } from "@slashwho/contracts";

import {
  characterPathSegments,
  raiderIoCharacterUrl,
  warcraftLogsCharacterUrl
} from "../lib/dossier-path";
import { UpstreamIconLink } from "./upstream-icon-link";

type ProfileCharacter = Readonly<{
  key: CharacterKey;
  displayName: string;
}>;

type ProfileGuild = Readonly<{
  name: string;
  region: CharacterKey["region"];
  realm: string;
}>;

export function CharacterProfileLinks({
  character
}: Readonly<{ character: ProfileCharacter }>) {
  const { key, displayName } = character;
  return (
    <span className="profile-links">
      <UpstreamIconLink
        href={raiderIoCharacterUrl(key)}
        label={`View ${displayName} on Raider.IO`}
        source="raiderio"
      />
      <UpstreamIconLink
        href={warcraftLogsCharacterUrl(key)}
        label={`View ${displayName} on Warcraft Logs`}
        source="warcraft_logs"
      />
    </span>
  );
}

export function GuildProfileLinks({
  guild
}: Readonly<{ guild: ProfileGuild }>) {
  // A guild's path has a character's shape: region, realm, then its name.
  const path = characterPathSegments(guild);
  return (
    <span className="profile-links">
      <UpstreamIconLink
        href={`https://raider.io/guilds/${path}`}
        label={`View ${guild.name} on Raider.IO`}
        source="raiderio"
      />
      <UpstreamIconLink
        href={`https://www.warcraftlogs.com/guild/${path}`}
        label={`View ${guild.name} on Warcraft Logs`}
        source="warcraft_logs"
      />
    </span>
  );
}
