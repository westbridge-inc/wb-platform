import { BROWSER_API_ORIGIN as API_URL } from '@/lib/browser-api-origin';

/**
 * [HOME-NOTICE · owner 13 Nov 2026] The notice at the top of the customer Home.
 *
 * The owner sets the words in the admin console (the API's ops/home-notice.ts);
 * everyone sees them, signed in or not, until the owner turns the notice off. A
 * person closes it with an X, and this browser remembers the notice ids it
 * closed: the same notice stays closed after a reload, and new words (a new id)
 * show again. Storage that is blocked or broken only means a closed notice may
 * come back on the next visit — it is never a reason to hide one.
 */

export interface HomeNoticeView {
  id: string;
  title: string | null;
  body: string;
}

export const CLOSED_NOTICES_KEY = 'swift:home-notice:closed';
/** Enough history for every notice anyone will close; the oldest drop off. */
const CLOSED_KEEP = 20;

/** The server's answer as a notice, or null for none (or anything malformed). */
export function homeNoticeOf(data: unknown): HomeNoticeView | null {
  const notice = data && typeof data === 'object' ? (data as { notice?: unknown }).notice : null;
  if (!notice || typeof notice !== 'object') return null;
  const n = notice as Record<string, unknown>;
  const id = typeof n['id'] === 'string' ? n['id'] : '';
  const body = typeof n['body'] === 'string' ? n['body'].trim() : '';
  if (!id || !body) return null;
  const title = typeof n['title'] === 'string' && n['title'].trim() ? n['title'].trim() : null;
  return { id, title, body };
}

/**
 * The live notice, read with no session at all (it carries nothing personal),
 * so a guest and a stale cookie read the same thing. The API lets browsers keep
 * the answer for a minute.
 */
export async function fetchHomeNotice(): Promise<HomeNoticeView | null> {
  const response = await fetch(`${API_URL}/api/v1/public/home-notice`, { credentials: 'omit' });
  const json = await response.json().catch(() => null);
  if (!response.ok || json?.success === false) throw new Error('The notice could not be read.');
  return homeNoticeOf(json?.data);
}

/** The notice ids this browser closed, oldest first. */
export function closedNoticeIds(): string[] {
  try {
    const raw = localStorage.getItem(CLOSED_NOTICES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember that this browser closed a notice. Best effort: blocked storage is not an error. */
export function rememberClosedNotice(id: string): void {
  try {
    const next = [...closedNoticeIds().filter((closed) => closed !== id), id].slice(-CLOSED_KEEP);
    localStorage.setItem(CLOSED_NOTICES_KEY, JSON.stringify(next));
  } catch {
    // The notice still closes for this visit.
  }
}
