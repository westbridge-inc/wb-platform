/**
 * [MENU-OPTIONS · owner 11 Nov 2026] What every menu-options write declares: this app shows and edits sizes that set
 * the price, halves and follow-up choices. The API refuses such an item from an app that does not say so: a customer's
 * cart write gets 409 APP_UPDATE_REQUIRED (a guest-basket merge line comes back OPTIONS_CHANGED), and so does a store
 * app's edit of a group that uses those rules (an older store app would misread a size's price as an add-on).
 *
 * Its own file, importing nothing, so a sender carries only this: the website's shared customer client
 * (apps/web/src/lib/customer.ts, on every ordering page) imports it by path without pulling the item sheet's model
 * (menuSheet.ts) into every page's first load. apps/web/Dockerfile copies exactly this file.
 */
export const MENU_OPTIONS_CAPABILITY = 'MENU_OPTIONS_V2';

/** A fresh list for a request body. */
export function cartWriteCapabilities(): string[] {
  return [MENU_OPTIONS_CAPABILITY];
}
