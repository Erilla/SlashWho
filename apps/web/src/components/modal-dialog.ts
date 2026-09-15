/**
 * jsdom, and browsers without dialog support, implement neither showModal nor
 * close. showModal gives the top layer, an inert backdrop and Escape handling
 * where it exists; the open attribute is the honest fallback everywhere else.
 */
export function supportsModalDialog(dialog: HTMLDialogElement): boolean {
  return typeof dialog.showModal === "function";
}

export function openDialog(dialog: HTMLDialogElement): void {
  if (supportsModalDialog(dialog)) dialog.showModal();
  else dialog.setAttribute("open", "");
}

export function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}
