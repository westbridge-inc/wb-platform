/**
 * [ROLE-DOCS · owner ruling 21 Oct 2026] "I trade under my own name": the words a store owner ticks in place of a
 * business registration, ONLY where the Business Names (Registration) Act, Cap. 90:05, s.3 makes registration
 * unnecessary (one person whose store's name is their true surname with nothing added but their first names or
 * initials). The server's words (apps/api/src/modules/vendor/own-name.ts OWN_NAME_DECLARATION_V1) are the signed
 * version; a test keeps these equal.
 */
export const OWN_NAME_DECLARATION_VERSION = 'v1';

export const OWN_NAME_DECLARATION_V1 = `I TRADE UNDER MY OWN NAME (v1)

I declare that:
1. I run this store myself, as one person (not a partnership or a company).
2. The store's name is my true surname, with nothing added except my true first names or their initials.
3. I have not changed my name, except where I am a woman whose name changed because of marriage.
4. Under the Business Names (Registration) Act, Cap. 90:05, section 3, I therefore do not need to register a business name.
5. If I trade under any other name, I will register it with the Deeds and Commercial Registries Authority (DCRA) and upload the certificate to Swift before I use it.`;

/** The sign-up's question, in the owner's words. */
export const OWN_NAME_QUESTION = 'What name does your store use?';
// [OWNER-ASKS 9 Nov 2026] Each choice says what it is; the declaration's tick says what ticking it means.
export const OWN_NAME_CHOICE = 'My own name — I’m one person trading under just my surname, with or without my first names or initials (for example “Persaud” or “R. Persaud”)';
export const BUSINESS_NAME_CHOICE = 'A registered business name or a company (I have the DCRA certificate)';
export const OWN_NAME_HINT = 'The law does not ask you to register your own name as a business name, so you sign a short declaration instead of uploading a business registration. A person on our team checks it against your ID.';
export const OWN_NAME_TICK = 'I have read and agree to this declaration.';

/** [OWNER-ASKS 9 Nov 2026] The plain title shown in place of the declaration's raw first line. */
export const OWN_NAME_DECLARATION_TITLE = 'Declaration: I trade under my own name';

/**
 * [OWNER-ASKS 9 Nov 2026] How the declaration is SHOWN: its raw first line ("I TRADE UNDER MY OWN NAME (v1)") becomes
 * a plain title and a "Version N" line; the body is the signed words unchanged. Presentation only: what is signed and
 * versioned is still OWN_NAME_DECLARATION_V1 (and the server's words), and `heading` + a blank line + `body` is
 * exactly that text. Words with no such first line are shown whole.
 */
export function ownNameDeclarationDisplay(text: string): { heading: string; title: string; version: string | null; body: string } {
  const split = text.indexOf('\n\n');
  const heading = split > 0 ? text.slice(0, split) : '';
  const version = /\(v(\d+)\)\s*$/.exec(heading);
  if (!heading || !version) return { heading: '', title: OWN_NAME_DECLARATION_TITLE, version: null, body: text };
  return { heading, title: OWN_NAME_DECLARATION_TITLE, version: `Version ${version[1]}`, body: text.slice(split + 2) };
}

/** The vendor types whose checklist asks for a business registration (a service business is never asked). */
export function ownNameApplies(vendorType: string): boolean {
  return vendorType === 'RESTAURANT' || vendorType === 'SUPERMARKET' || vendorType === 'STORE';
}

/** [ROLE-DOCS · REVIEW-F #2046 S4-1] The declaration is per store: the line that names the store it is signed for. */
export function ownNameSigningFor(storeName: string | null | undefined): string | null {
  const name = storeName?.trim();
  return name ? `You sign this for “${name}” only.` : null;
}

/**
 * [OWNNAME-FIT · COORD ruling 7 Nov 2026, Cap. 90:05 s.3] Offer "No business name? Trade under your own name" only for
 * a store whose name passes the server's own-name test: GET /verification/status `ownNameFits` (store id → true/false,
 * the same test POST /vendor/onboarding/own-name applies). No store, no answer for it, or an older server that sends
 * none: no offer (the server would refuse a name that does not fit anyway). Never decides the signing itself.
 */
export function ownNameOfferFits(status: unknown, storeId: string | null | undefined): boolean {
  if (!storeId || !status || typeof status !== 'object') return false;
  const fits = (status as { ownNameFits?: unknown }).ownNameFits;
  if (!fits || typeof fits !== 'object' || Array.isArray(fits)) return false;
  return (fits as Record<string, unknown>)[storeId] === true;
}
