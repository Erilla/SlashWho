"use client";

import type { ApplicantDossier } from "@slashwho/contracts";
import { useEffect, useMemo, useState } from "react";

export function dossierRaidTargetId(raidId: string) {
  return `dossier-raid-${raidId}`;
}

type Section = Readonly<{
  id: string;
  label: string;
  raidName?: string;
  raid?: boolean;
}>;

export function DossierSectionNavigation({
  raids,
  hasLimitations
}: Readonly<{
  raids: ApplicantDossier["raids"];
  hasLimitations: boolean;
}>) {
  const sections = useMemo<Section[]>(
    () => [
      { id: "dossier-characters-heading", label: "Connected characters" },
      { id: "historic-cutting-edge-heading", label: "Historic Cutting Edge" },
      {
        id: "historic-mythic-evidence-heading",
        label: "Historic Mythic boss evidence"
      },
      ...raids.map((raid) => ({
        id: dossierRaidTargetId(raid.raidId),
        label: `Raid: ${raid.raidName}`,
        raidName: raid.raidName,
        raid: true
      })),
      ...(hasLimitations
        ? [{ id: "limitations-heading", label: "Data limitations" }]
        : [])
    ],
    [raids, hasLimitations]
  );
  const [activeId, setActiveId] = useState(sections[0]?.id);
  const sectionIds = sections.map((section) => section.id).join("|");

  const navigateTo = (id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    const headerBottom =
      document.querySelector(".site-header")?.getBoundingClientRect().bottom ??
      0;
    window.history.pushState(null, "", `#${id}`);
    window.scrollTo({
      top:
        window.scrollY + target.getBoundingClientRect().top - headerBottom - 12,
      behavior: "instant"
    });
    setActiveId(id);
  };

  useEffect(() => {
    const ids = sectionIds.split("|");
    const updateActive = () => {
      const offset =
        document.querySelector(".site-header")?.getBoundingClientRect()
          .bottom ?? 64;
      let current = ids[0];
      for (const id of ids) {
        const target = document.getElementById(id);
        if (target && target.getBoundingClientRect().top <= offset + 24)
          current = id;
      }
      setActiveId(current);
    };

    updateActive();
    window.addEventListener("scroll", updateActive, { passive: true });
    window.addEventListener("resize", updateActive);
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(updateActive)
        : null;
    const dossier = document.querySelector(".dossier-layout");
    if (dossier) observer?.observe(dossier);
    return () => {
      window.removeEventListener("scroll", updateActive);
      window.removeEventListener("resize", updateActive);
      observer?.disconnect();
    };
  }, [sectionIds]);

  return (
    <nav aria-label="Dossier sections" className="dossier-section-navigation">
      <p className="dossier-section-navigation-title">On this page</p>
      <ol>
        {sections.map((section) => (
          <li key={section.id}>
            <a
              aria-current={activeId === section.id ? "location" : undefined}
              className={
                section.raid ? "dossier-section-navigation-raid" : undefined
              }
              aria-label={section.label}
              href={`#${section.id}`}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                navigateTo(section.id);
              }}
            >
              <span
                className="dossier-section-navigation-label"
                data-raid-name={section.raidName}
              >
                {section.label}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
