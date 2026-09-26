/**
 * Which Wowhead icon stands for each class specialisation. Presentation data
 * the Warcraft Logs client used to carry itself: a provider only reports a
 * specialisation's name, and what it looks like is ours to decide.
 */

// Keyed by class then specialisation, because four specialisation names are
// shared by two classes each (Frost, Holy, Protection, Restoration) and a
// name-only lookup silently hands one class the other's icon.
const specIconNames: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  DeathKnight: {
    Blood: "spell_deathknight_bloodpresence",
    Frost: "spell_deathknight_frostpresence",
    Unholy: "spell_deathknight_unholypresence"
  },
  DemonHunter: {
    Devourer: "classicon_demonhunter_void",
    Havoc: "ability_demonhunter_specdps",
    Vengeance: "ability_demonhunter_spectank"
  },
  Druid: {
    Balance: "spell_nature_starfall",
    Feral: "ability_druid_catform",
    Guardian: "ability_racial_bearform",
    Restoration: "spell_nature_healingtouch"
  },
  Evoker: {
    Augmentation: "classicon_evoker_augmentation",
    Devastation: "classicon_evoker_devastation",
    Preservation: "classicon_evoker_preservation"
  },
  Hunter: {
    BeastMastery: "ability_hunter_bestialdiscipline",
    Marksmanship: "ability_hunter_focusedaim",
    Survival: "ability_hunter_camouflage"
  },
  Mage: {
    Arcane: "spell_holy_magicalsentry",
    Fire: "spell_fire_firebolt02",
    Frost: "spell_frost_frostbolt02"
  },
  Monk: {
    Brewmaster: "spell_monk_brewmaster_spec",
    Mistweaver: "spell_monk_mistweaver_spec",
    Windwalker: "spell_monk_windwalker_spec"
  },
  Paladin: {
    Holy: "spell_holy_holybolt",
    Protection: "ability_paladin_shieldofthetemplar",
    Retribution: "spell_holy_auraoflight"
  },
  Priest: {
    Discipline: "spell_holy_powerwordshield",
    Holy: "spell_holy_guardianspirit",
    Shadow: "spell_shadow_shadowwordpain"
  },
  Rogue: {
    Assassination: "ability_rogue_deadlybrew",
    Outlaw: "ability_rogue_waylay",
    Subtlety: "ability_stealth"
  },
  Shaman: {
    Elemental: "spell_nature_lightning",
    Enhancement: "spell_shaman_improvedstormstrike",
    Restoration: "spell_nature_magicimmunity"
  },
  Warlock: {
    Affliction: "spell_shadow_deathcoil",
    Demonology: "spell_shadow_metamorphosis",
    Destruction: "spell_shadow_rainoffire"
  },
  Warrior: {
    Arms: "ability_warrior_savageblow",
    Fury: "ability_warrior_innerrage",
    Protection: "ability_warrior_defensivestance"
  }
};

// Warcraft Logs does not always report a class alongside a specialisation. A
// name that belongs to exactly one class stays resolvable on its own; a shared
// name without a class resolves to nothing, because a guess renders a
// confidently wrong icon.
const unambiguousSpecIconNames: ReadonlyMap<string, string> = (() => {
  const counts = new Map<string, string | null>();
  for (const specs of Object.values(specIconNames)) {
    for (const [specName, iconName] of Object.entries(specs)) {
      counts.set(specName, counts.has(specName) ? null : iconName);
    }
  }
  return new Map(
    [...counts].flatMap(([specName, iconName]) =>
      iconName === null ? [] : [[specName, iconName] as const]
    )
  );
})();

function specKey(value: string): string {
  return value.replaceAll(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The icon for a specialisation, or null when none can be named with
 * confidence. Providers rarely report a class beside a specialisation, so
 * `className` — which the caller may already hold for the character, and which
 * cannot change — settles the four specialisation names that two classes share.
 */
export function specIconUrl(
  specName: string,
  className?: string | null
): string | null {
  const spec = specKey(specName);
  const specClass = specKey(className ?? "");
  const iconName =
    (specClass === "" ? undefined : specIconNames[specClass]?.[spec]) ??
    unambiguousSpecIconNames.get(spec);
  return iconName === undefined
    ? null
    : `https://wow.zamimg.com/images/wow/icons/medium/${iconName}.jpg`;
}
