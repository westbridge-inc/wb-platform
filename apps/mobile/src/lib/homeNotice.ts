/**
 * [HOME-NOTICE · owner 13 Nov 2026] The notice at the top of Home.
 *
 * The owner sets the words in the admin console (the API's ops/home-notice.ts)
 * and GET /public/home-notice answers them to everyone, signed in or not, until
 * the owner turns the notice off. A person closes it with an X; this phone
 * remembers the notice ids it closed, so reopening the app keeps a closed
 * notice closed, and new words (a new id) show again.
 *
 * Pure: no react-native here, so it is tested in Node. The phone's storage is
 * passed in (lib/homeNoticeMemory.ts binds it), and every read and write is
 * fail-safe — a store that fails means a closed notice may come back, never a
 * crash on Home and never a notice hidden from someone who did not close it.
 */

export interface HomeNoticeView {
  id: string;
  title: string | null;
  body: string;
}

/** The slice of MMKV this needs; a test passes a map. */
export interface NoticeMemory {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
}

export const CLOSED_NOTICES_SLOT = 'closed';
/** Enough history for every notice anyone will close; the oldest drop off. */
const CLOSED_KEEP = 20;

/** The server's whole answer (`{ success, data: { notice } }`) as a notice, or null. */
export function homeNoticeOf(response: unknown): HomeNoticeView | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as { success?: unknown; data?: { notice?: unknown } | null };
  if (r.success !== true) return null;
  const notice = r.data?.notice;
  if (!notice || typeof notice !== 'object') return null;
  const n = notice as Record<string, unknown>;
  const id = typeof n['id'] === 'string' ? n['id'] : '';
  const body = typeof n['body'] === 'string' ? n['body'].trim() : '';
  if (!id || !body) return null;
  const title = typeof n['title'] === 'string' && n['title'].trim() ? n['title'].trim() : null;
  return { id, title, body };
}

/** The notice ids this phone closed, oldest first. */
export function closedNoticeIds(memory: NoticeMemory | null): string[] {
  try {
    const raw = memory?.getString(CLOSED_NOTICES_SLOT);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember that this phone closed a notice. Best effort. */
export function rememberClosedNotice(memory: NoticeMemory | null, id: string): void {
  try {
    const next = [...closedNoticeIds(memory).filter((closed) => closed !== id), id].slice(-CLOSED_KEEP);
    memory?.set(CLOSED_NOTICES_SLOT, JSON.stringify(next));
  } catch {
    // The notice still closes for as long as the app stays open.
  }
}

/** The notice to draw: the live one, unless this phone closed it. */
export function noticeToShow(notice: HomeNoticeView | null, closedIds: readonly string[]): HomeNoticeView | null {
  return notice && !closedIds.includes(notice.id) ? notice : null;
}
