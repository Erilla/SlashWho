import type { CharacterKey } from "@slashwho/contracts";

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

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function CharacterProfileLinks({
  character
}: Readonly<{ character: ProfileCharacter }>) {
  const { key, displayName } = character;
  const path = `${segment(key.region)}/${segment(key.realm)}/${segment(key.name)}`;
  return (
    <span className="profile-links">
      <UpstreamIconLink
        href={`https://raider.io/characters/${path}`}
        label={`View ${displayName} on Raider.IO`}
        source="raiderio"
      />
      <UpstreamIconLink
        href={`https://www.warcraftlogs.com/character/${path}`}
        label={`View ${displayName} on Warcraft Logs`}
        source="warcraft_logs"
      />
    </span>
  );
}

export function GuildProfileLinks({
  guild
}: Readonly<{ guild: ProfileGuild }>) {
  const path = `${segment(guild.region)}/${segment(guild.realm)}/${segment(guild.name)}`;
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
