import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ValidationError } from '../../utils/errors';

/**
 * [HOME-NOTICE · owner 13 Nov 2026] THE HOME NOTICE.
 *
 * A small notice at the top of the customer Home, on the phone app and the
 * website, for EVERYONE — signed in or not. A person closes it with an X and it
 * stays closed on that device for that notice; it shows until the owner stops
 * it. The words are the owner's, set in the admin console, never in code.
 *
 * An OPS setting, deliberately NOT part of the platform spine (like
 * ops/app-version.ts): this one PlatformConfig key is absent from
 * desiredPlatformConfig(), so the signed seed never plans, writes or reverts
 * it. Absent = off: no notice shows until one is turned on.
 *
 * The row is written only by its own console routes (admin.routes.ts), never by
 * the generic PUT /config/:key (machine-owned-config.ts), so a stored notice
 * always passed the word checks below:
 *   - PUT  /admin/home-notice       C5 — turning words ON for every customer is
 *     platform text like a broadcast: a reason and a second admin (solo mode
 *     with its wait while the owner is the only admin).
 *   - POST /admin/home-notice/stop  C3 — turning it OFF is immediate: a reason,
 *     no second person. Stopping can only remove words from customers' screens,
 *     and the safe direction must never wait hours in an approvals queue.
 * Both write the row and their audit row in one transaction.
 *
 * THE ID FOLLOWS THE WORDS. A notice's id is a hash of its title and body. A
 * device remembers the ids it closed, so new words show again to everyone, and
 * the same words turned off and on again stay closed for people who closed them.
 */

export const HOME_NOTICE_KEY = 'home.notice';
export const HOME_NOTICE_TITLE_MAX = 60;
export const HOME_NOTICE_BODY_MAX = 280;

/** The row as stored. A stopped notice keeps its words, so the console shows what was last live. */
export interface StoredHomeNotice {
  active: boolean;
  id: string;
  title: string | null;
  body: string;
  /** ISO time of the last change. */
  updatedAt: string;
}

/** What the public route answers: the words, the id a device remembers, and when they changed. */
export interface PublicHomeNotice {
  id: string;
  title: string | null;
  body: string;
  updatedAt: string;
}

export interface HomeNoticeWords {
  title: string | null;
  body: string;
}

// Words that could hide or reorder text are refused:
//   - C0/C1 controls;
//   - [ROUND 2 · REVIEW-A/B S4-1] every Unicode FORMAT character (\p{Cf}): the bidi overrides/isolates and marks
//     (LRM/RLM, the Arabic letter mark), zero-width space/joiner/non-joiner, word joiner and the invisible operators,
//     a BOM, the soft hyphen, the tag block. An approver cannot see them, and two notices that look the same would
//     carry two ids. The one exception is a zero-width joiner INSIDE an emoji (woman + ZWJ + cooking = a woman cook);
//   - more than three combining marks stacked on one letter (they paint over the lines around the banner);
//   - half of a surrogate pair (\p{Cs} under the u flag matches only an unpaired half), which the database cannot
//     store as JSON: refused here as a 400 at the ask, never a 500.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
const FORMAT_CHARS = /\p{Cf}/u;
const LONE_SURROGATE = /\p{Cs}/u;
const STACKED_MARKS = /\p{M}{4,}/u;
/** A zero-width joiner between two emoji (after an optional emoji selector or skin tone), part of one emoji. */
const EMOJI_JOINER = /(?<=\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)\u200D(?=\p{Extended_Pictographic})/gu;

/** Whether the words carry a character that could hide or reorder text (see above). */
function hasUnsafeChars(text: string): boolean {
  return CONTROL_CHARS.test(text) || LONE_SURROGATE.test(text) || STACKED_MARKS.test(text)
    || FORMAT_CHARS.test(text.replace(EMOJI_JOINER, ''));
}

/** Plain text, one line: every run of whitespace (newlines included) becomes one space. */
function tidy(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * The words an admin asked for, checked and tidied, or a 400. The one check
 * the route, the approval ask and the stored-row reader share.
 */
export function homeNoticeWordsOf(input: unknown): HomeNoticeWords {
  const raw = (input && typeof input === 'object' ? input : {}) as { title?: unknown; body?: unknown };
  if (raw.title !== undefined && raw.title !== null && typeof raw.title !== 'string') throw new ValidationError('The title must be text.');
  if (typeof raw.body !== 'string') throw new ValidationError('Write the notice.');
  // Unsafe characters are judged on what was sent: tidying would turn a tab or newline into a space first.
  const sent = `${typeof raw.title === 'string' ? raw.title : ''}${raw.body}`.replace(/[\t\n\r]/g, ' ');
  if (hasUnsafeChars(sent)) throw new ValidationError('The notice has a hidden character in it. Type it again as plain text.');
  const title = tidy(raw.title);
  const body = tidy(raw.body);
  if (!body) throw new ValidationError('Write the notice.');
  if (body.length > HOME_NOTICE_BODY_MAX) throw new ValidationError(`Keep the notice to ${HOME_NOTICE_BODY_MAX} characters.`);
  if (title.length > HOME_NOTICE_TITLE_MAX) throw new ValidationError(`Keep the title to ${HOME_NOTICE_TITLE_MAX} characters.`);
  return { title: title || null, body };
}

/** A notice's id: the same words always give the same id; any change gives a new one. */
export function noticeIdOf(title: string | null | undefined, body: string): string {
  return createHash('sha256').update(JSON.stringify([title ?? '', body])).digest('hex').slice(0, 16);
}

/** A stored value as a notice (live or stopped), or null for a missing or malformed row. */
export function storedHomeNoticeOf(value: unknown): StoredHomeNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v['active'] !== 'boolean' || typeof v['id'] !== 'string' || !/^[0-9a-f]{16}$/.test(v['id'])) return null;
  let words: HomeNoticeWords;
  try {
    words = homeNoticeWordsOf({ title: v['title'], body: v['body'] });
  } catch {
    return null;
  }
  const updatedAt = typeof v['updatedAt'] === 'string' && !Number.isNaN(Date.parse(v['updatedAt'])) ? v['updatedAt'] : new Date(0).toISOString();
  return { active: v['active'], id: v['id'], title: words.title, body: words.body, updatedAt };
}

/** What customers are shown: only an ACTIVE, well-formed notice. Anything else is no notice. */
export function publicHomeNoticeOf(value: unknown): PublicHomeNotice | null {
  const stored = storedHomeNoticeOf(value);
  if (!stored || !stored.active) return null;
  return { id: stored.id, title: stored.title, body: stored.body, updatedAt: stored.updatedAt };
}

type ConfigReader = Pick<PrismaClient, 'platformConfig'>;

/** The stored notice, read fresh. */
export async function readHomeNotice(prisma: ConfigReader | Prisma.TransactionClient): Promise<StoredHomeNotice | null> {
  const row = await prisma.platformConfig.findUnique({ where: { key: HOME_NOTICE_KEY }, select: { value: true } });
  return storedHomeNoticeOf(row?.value);
}

/** The notice customers see right now, or null. */
export async function readPublicHomeNotice(prisma: ConfigReader): Promise<PublicHomeNotice | null> {
  const row = await prisma.platformConfig.findUnique({ where: { key: HOME_NOTICE_KEY }, select: { value: true } });
  return publicHomeNoticeOf(row?.value);
}

async function write(tx: Prisma.TransactionClient, notice: StoredHomeNotice): Promise<void> {
  const value = notice as unknown as Prisma.InputJsonValue;
  await tx.platformConfig.upsert({ where: { key: HOME_NOTICE_KEY }, update: { value }, create: { key: HOME_NOTICE_KEY, value } });
}

export interface HomeNoticeChange {
  before: StoredHomeNotice | null;
  after: StoredHomeNotice | null;
}

/** Turn these words on. Call inside the route's transaction, before its audit row. */
export async function startHomeNotice(tx: Prisma.TransactionClient, input: unknown, now = new Date()): Promise<HomeNoticeChange> {
  const words = homeNoticeWordsOf(input);
  const before = await readHomeNotice(tx);
  const after: StoredHomeNotice = { active: true, id: noticeIdOf(words.title, words.body), title: words.title, body: words.body, updatedAt: now.toISOString() };
  await write(tx, after);
  return { before, after };
}

/** Turn the notice off, keeping its words for the console. Nothing live: nothing is written. */
export async function stopHomeNotice(tx: Prisma.TransactionClient, now = new Date()): Promise<HomeNoticeChange> {
  const before = await readHomeNotice(tx);
  if (!before || !before.active) return { before, after: before };
  const after: StoredHomeNotice = { ...before, active: false, updatedAt: now.toISOString() };
  await write(tx, after);
  return { before, after };
}
