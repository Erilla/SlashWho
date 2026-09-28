const MENU_KEYS = ["ArrowDown", "ArrowUp", "Home", "End"];

/**
 * Moves focus between a menu's items for the arrow, Home and End keys,
 * wrapping at either end. Returns whether the key was one of those, so the
 * caller knows to cancel its default.
 */
export function moveMenuFocus(menu: HTMLElement | null, key: string): boolean {
  if (!MENU_KEYS.includes(key)) return false;
  const items = Array.from(
    menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []
  );
  if (items.length === 0) return false;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? items.length - 1
        : key === "ArrowDown"
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
  items[next]?.focus();
  return true;
}
