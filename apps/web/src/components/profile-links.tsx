import type { CharacterKey } from "@slashwho/contracts";

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

function icon(label: "RIO" | "WCL") {
  return <span aria-hidden="true">{label}</span>;
}

export function CharacterProfileLinks({
  character
}: Readonly<{ character: ProfileCharacter }>) {
  const { key, displayName } = character;
  const path = `${segment(key.region)}/${segment(key.realm)}/${segment(key.name)}`;
  return (
    <span className="profile-links">
      <a
        aria-label={`View ${displayName} on Raider.IO (opens in a new tab)`}
        className="profile-link profile-link-raiderio"
        href={`https://raider.io/characters/${path}`}
        rel="noopener noreferrer"
        target="_blank"
      >
        {icon("RIO")}
      </a>
      <a
        aria-label={`View ${displayName} on Warcraft Logs (opens in a new tab)`}
        className="profile-link profile-link-warcraft-logs"
        href={`https://www.warcraftlogs.com/character/${path}`}
        rel="noopener noreferrer"
        target="_blank"
      >
        {icon("WCL")}
      </a>
    </span>
  );
}

export function GuildProfileLinks({
  guild
}: Readonly<{ guild: ProfileGuild }>) {
  const path = `${segment(guild.region)}/${segment(guild.realm)}/${segment(guild.name)}`;
  return (
    <span className="profile-links">
      <a
        aria-label={`View ${guild.name} on Raider.IO (opens in a new tab)`}
        className="profile-link profile-link-raiderio"
        href={`https://raider.io/guilds/${path}`}
        rel="noopener noreferrer"
        target="_blank"
      >
        {icon("RIO")}
      </a>
      <a
        aria-label={`View ${guild.name} on Warcraft Logs (opens in a new tab)`}
        className="profile-link profile-link-warcraft-logs"
        href={`https://www.warcraftlogs.com/guild/${path}`}
        rel="noopener noreferrer"
        target="_blank"
      >
        {icon("WCL")}
      </a>
    </span>
  );
}
