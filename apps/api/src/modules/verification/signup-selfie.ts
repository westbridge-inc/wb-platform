/**
 * [Item 98] THE SIGNUP SELFIE BESIDE THE ID — compared by a person, never by a machine.
 *
 * Face-matching is deliberately off at launch (owner ruling, row 54), so a
 * reviewer checking an identity document compares the applicant's own signup
 * selfie with the photo on the ID by eye. The selfie travels only inside a
 * granted, audited view of an identity document (admin document-url), and
 * only when the stored pointer is the applicant's own capture: the POST
 * /auth/selfie writer files it under `avatars/<their id>/`. Anything else —
 * someone else's folder, a path that climbs out of it, a photo that was never
 * captured — shows nothing rather than a stand-in face.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { isStoredName } from '../../providers/storage/stored-name';
import { resolveAvatarUrl } from '../../utils/avatar-url';
import { SELFIE_COMPARE_DOC_TYPES } from './doc-registry';
import { ownerOffersHomeVisits, proHomeJobsSelfieEnabled } from './home-visits';

/**
 * [OWNER-ASKS · owner ruling 9 Nov 2026] WHO TAKES THE SIGN-UP SELFIE: riders and drivers, an independent service pro
 * (owner ruling 9 Nov ~20:1xZ (A); never an advertiser, (B)), and a service business that goes to the customer (a listing that comes to the customer's home: MOBILE or BOTH). A store owner, store staff and a
 * business that serves customers only at its own place never take one; customers never do. Identity-document checks are
 * unchanged. A photo already on file stays stored and protected exactly as before; it is simply not asked for, compared
 * or shown to a reviewer where the person is not one who needs it.
 */
export const SELFIE_ROLES: ReadonlySet<string> = new Set(['RIDER', 'DRIVER', 'MOVER']);

export async function signupSelfieRequired(db: Prisma.TransactionClient | PrismaClient, userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { roles: true } });
  if (!user) return false;
  if (user.roles.some((role) => SELFIE_ROLES.has(role))) return true;
  // [owner ruling 9 Nov ~20:1xZ (A)] an independent service pro goes to customers' homes
  // (behind the PRO_HOME_JOBS_SELFIE switch, review P1: off, a pro is asked nothing new)
  if (proHomeJobsSelfieEnabled() && (await db.serviceProvider.count({ where: { userId } })) > 0) return true;
  return ownerOffersHomeVisits(db, userId);
}

export interface SignupSelfie { url: string; capturedAt: string }

/** Is this stored pointer the applicant's own selfie object (local path or storage key)? */
export function isOwnSelfiePointer(userId: string, avatar: string | null | undefined): boolean {
  if (!avatar) return false;
  const key = avatar.startsWith('/uploads/') ? avatar.slice('/uploads/'.length) : avatar;
  const parts = key.split('/');
  return parts.length === 3 && parts[0] === 'avatars' && parts[1] === userId && isStoredName(parts[2]!);
}

/** The selfie to show beside this document, or null. Only a photo ID carries one (national ID, passport or licence),
 *  and only for a person who takes one (`required`, signupSelfieRequired): a store owner's review is the ID alone. */
export async function signupSelfieFor(
  docType: string,
  user: { id: string; avatar: string | null; selfieCapturedAt: Date | null } | null,
  required: boolean,
): Promise<SignupSelfie | null> {
  if (!user || !required || !SELFIE_COMPARE_DOC_TYPES.has(docType)) return null;
  if (!user.selfieCapturedAt || !isOwnSelfiePointer(user.id, user.avatar)) return null;
  const url = await resolveAvatarUrl(user.avatar);
  return url ? { url, capturedAt: user.selfieCapturedAt.toISOString() } : null;
}
