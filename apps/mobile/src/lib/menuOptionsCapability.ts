/**
 * [MENU-OPTIONS · owner 11 Nov 2026] What every cart write declares: this app shows sizes that set the price, halves
 * and follow-up choices (the API refuses such an item from an app that does not say so: 409 APP_UPDATE_REQUIRED;
 * a guest-basket merge line comes back OPTIONS_CHANGED).
 *
 * Its own file, importing nothing, so a cart-write sender carries only this: the website's shared customer client
 * (apps/web/src/lib/customer.ts, on every ordering page) imports it by path without pulling the item sheet's model
 * (menuSheet.ts) into every page's first load. apps/web/Dockerfile copies exactly this file.
 */
export const MENU_OPTIONS_CAPABILITY = 'MENU_OPTIONS_V2';

/** A fresh list for a request body. */
export function cartWriteCapabilities(): string[] {
  return [MENU_OPTIONS_CAPABILITY];
}
