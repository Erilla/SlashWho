"use client";

import type { ApplicantDossier } from "@slashwho/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export function dossierRaidTargetId(raidId: string) {
  return `dossier-raid-${raidId}`;
}

type Section = Readonly<{
  id: string;
  label: string;
  shortLabel?: string;
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
      {
        id: "dossier-characters-heading",
        label: "Connected characters",
        shortLabel: "Characters"
      },
      {
        id: "historic-cutting-edge-heading",
        label: "Historic Cutting Edge",
        shortLabel: "Cutting Edge"
      },
      {
        id: "historic-mythic-evidence-heading",
        label: "Historic Mythic boss evidence",
        shortLabel: "Mythic evidence"
      },
      ...raids.map((raid) => ({
        id: dossierRaidTargetId(raid.raidId),
        label: `Raid: ${raid.raidName}`,
        raidName: raid.raidName,
        raid: true
      })),
      ...(hasLimitations
        ? [
            {
              id: "limitations-heading",
              label: "Data limitations",
              shortLabel: "Limitations"
            }
          ]
        : [])
    ],
    [raids, hasLimitations]
  );
  const [activeId, setActiveId] = useState(sections[0]?.id);
  const sectionIds = sections.map((section) => section.id).join("|");
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);

  const navigateTo = (id: string, updateHistory = true) => {
    const target = document.getElementById(id);
    if (!target) return;
    const headerBottom =
      document.querySelector(".site-header")?.getBoundingClientRect().bottom ??
      0;
    if (updateHistory) window.history.pushState(null, "", `#${id}`);
    window.scrollTo({
      top:
        window.scrollY + target.getBoundingClientRect().top - headerBottom - 12,
      behavior: "instant"
    });
    setActiveId(id);
  };

  useEffect(() => () => dragCleanupRef.current?.(), []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.dossierScrollbar = "";
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      root.dataset.dossierScrolling = "";
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(
        () => delete root.dataset.dossierScrolling,
        1000
      );
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (event.clientX >= window.innerWidth - 28)
        root.dataset.dossierScrollbarHover = "";
      else delete root.dataset.dossierScrollbarHover;
    };
    const onBlur = () => delete root.dataset.dossierScrollbarHover;

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("blur", onBlur);
    return () => {
      clearTimeout(scrollTimer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onBlur);
      delete root.dataset.dossierScrollbar;
      delete root.dataset.dossierScrolling;
      delete root.dataset.dossierScrollbarHover;
    };
  }, []);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      getComputedStyle(event.currentTarget).position !== "fixed"
    )
      return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const navigation = event.currentTarget;
    const link = target.closest("a[href^='#']");
    if (!link || !navigation.contains(link)) return;

    dragCleanupRef.current?.();
    suppressClickRef.current = false;
    const pointerId = event.pointerId;
    const startY = event.clientY;
    let dragged = false;
    let lastId: string | undefined;

    const scrubTo = (clientY: number) => {
      const links =
        navigation.querySelectorAll<HTMLAnchorElement>("a[href^='#']");
      let nearest: HTMLAnchorElement | undefined;
      let distance = Number.POSITIVE_INFINITY;
      for (const candidate of links) {
        const box = candidate.getBoundingClientRect();
        const nextDistance = Math.abs(clientY - box.top - box.height / 2);
        if (nextDistance < distance) {
          nearest = candidate;
          distance = nextDistance;
        }
      }
      const id = nearest?.getAttribute("href")?.slice(1);
      if (!id || id === lastId) return;
      lastId = id;
      navigateTo(id, false);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      delete navigation.dataset.dragging;
      dragCleanupRef.current = null;
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if (!(move.buttons & 1)) {
        onCancel();
        return;
      }
      if (!dragged && Math.abs(move.clientY - startY) < 4) return;
      dragged = true;
      navigation.dataset.dragging = "true";
      move.preventDefault();
      scrubTo(move.clientY);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      if (dragged) {
        scrubTo(up.clientY);
        if (lastId) window.history.replaceState(null, "", `#${lastId}`);
        suppressClickRef.current = true;
      }
      cleanup();
    };
    const onCancel = () => cleanup();

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
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
    <nav
      aria-label="Dossier sections"
      className="dossier-section-navigation"
      onPointerDown={startDrag}
    >
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
              draggable={false}
              href={`#${section.id}`}
              onClick={(event) => {
                if (
                  suppressClickRef.current &&
                  event.detail > 0 &&
                  event.button === 0 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey
                ) {
                  suppressClickRef.current = false;
                  event.preventDefault();
                  return;
                }
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
                data-short-label={section.shortLabel}
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
