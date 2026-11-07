import { requireAuthSessionSnapshot, requireAuthSessionForPrincipal, useAuthStore } from '../stores/authStore';
import { prepareUploadImage } from '../lib/uploadImage';
import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { track } from '../lib/analytics';
import { safetyApi } from '../services/api';
import { createSosKeyStore } from '../lib/sosKey';

/**
 * Emergency alert on any job that is not a taxi ride.
 *
 * The safety engine was built complete and then never called: `POST
 * /safety/sos` authorises the customer, the driver OR the rider on an order,
 * lifts the rate limit so a panicking person is never met with a 429, and
 * collapses repeats by idempotency key — and no surface in the product ever
 * invoked it. Taxi had its own `/rides/:id/sos`, so taxi had a button and
 * everyone else had nothing.
 */
function useSosPrincipal() {
  const user = useAuthStore((s) => s.user);
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  return { userId: user?.id ?? '', generation: sessionGeneration };
}

export function useJobSos() {
  const owner = useSosPrincipal();
  const qc = useQueryClient();
  // A ref, not state: a re-render must never hand the same emergency a new
  // identity, which is exactly what a fresh store would do.
  const keys = useRef(createSosKeyStore()).current;

  return useMutation({
    mutationFn: async ({
      jobId,
      coords,
    }: {
      jobId: string;
      coords?: { lat: number; lng: number; accuracyM?: number };
    }) => {
      const res = await safetyApi.sos({
        orderId: jobId,
        lat: coords?.lat,
        lng: coords?.lng,
        accuracyM: coords?.accuracyM,
        clientIdempotencyKey: keys.keyFor(jobId),
      }, requireAuthSessionForPrincipal(owner));
      requireAuthSessionForPrincipal(owner);
      return res.data?.data as SosRaised;
    },
    onSuccess: () => { track('job_sos', {}); void qc.invalidateQueries({ queryKey: ['safety'] }); },
  });
}

/**
 * [B3] Emergency alert on a SERVICE job — the last two uncovered surfaces:
 * a hired professional working in a stranger's home, and the customer whose
 * home they are in. A ServiceJob is not an order, so it rides its own SOS
 * context (`serviceJobId`); the server authorises exactly the job's customer
 * and its provider, and repeats collapse per job like they do per order.
 */
export function useServiceJobSos() {
  const owner = useSosPrincipal();
  const qc = useQueryClient();
  const keys = useRef(createSosKeyStore()).current;

  return useMutation({
    mutationFn: async ({
      serviceJobId,
      coords,
    }: {
      serviceJobId: string;
      coords?: { lat: number; lng: number; accuracyM?: number };
    }) => {
      const res = await safetyApi.sos({
        serviceJobId,
        lat: coords?.lat,
        lng: coords?.lng,
        accuracyM: coords?.accuracyM,
        clientIdempotencyKey: keys.keyFor(serviceJobId),
      }, requireAuthSessionForPrincipal(owner));
      requireAuthSessionForPrincipal(owner);
      return res.data?.data as SosRaised;
    },
    onSuccess: () => { track('service_job_sos', {}); void qc.invalidateQueries({ queryKey: ['safety'] }); },
  });
}

/** The raise response — the ceremony renders every state from these server
 *  facts (status + the server-owned grace deadline), never from assumption. */
export interface SosRaised {
  id: string;
  status: 'TRIGGER_PENDING' | 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED' | 'CANCELLED';
  graceEndsAt: string | null;
}

/** [REPORT-035 F-035-01 · S0] "I need help NOW" — TRIGGER_PENDING → ACTIVE
 *  without waiting for the promotion worker. The client half of the confirm
 *  endpoint that shipped with zero callers. */
export function useConfirmSos() {
  const owner = useSosPrincipal();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await safetyApi.confirmSos(id, requireAuthSessionForPrincipal(owner));
      requireAuthSessionForPrincipal(owner);
      return res.data?.data as { id: string; status: string };
    },
    meta: { silent: true },
  });
}

/** Cancel during the server grace window; a 409 means the window closed. */
export function useCancelSos() {
  const owner = useSosPrincipal();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await safetyApi.cancelSos(id, requireAuthSessionForPrincipal(owner));
      requireAuthSessionForPrincipal(owner);
      return res.data?.data as { id: string; status: string };
    },
    meta: { silent: true },
  });
}

// ---------------------------------------------------------------------------
// EMERGENCY CONTACTS [S15]
//
// The same shape of gap as the SOS button itself, one step further along the
// chain. `sos.service.ts` SMSes VERIFIED emergency contacts when an alert goes
// active — and no screen in the app could ever add one, so that query returned
// an empty list for every user and the fan-out reached nobody. The button was
// wired; the people it exists to reach were not.
// ---------------------------------------------------------------------------

export const emergencyContactKeys = { all: ['safety', 'emergency-contacts'] as const };

export interface EmergencyContact {
  id: string;
  name: string;
  phoneE164: string;
  relationship?: string | null;
  priority: number;
  verifiedAt: string | null;
  /** [Q9] The account's own number (a row saved before the API refused it):
   *  listed, never alerted. Absent from a server older than the flag. */
  isOwnNumber?: boolean;
}

export function useEmergencyContacts() {
  return useQuery<EmergencyContact[]>({
    queryKey: emergencyContactKeys.all,
    queryFn: async () => {
      const res = await safetyApi.listEmergencyContacts();
      return (res.data?.data ?? []) as EmergencyContact[];
    },
  });
}

/** Every write refetches the list — a contact's VERIFIED state is the whole
 *  point of the screen, and a stale badge would claim someone will be alerted
 *  in an emergency when they will not.
 *  [APP-SPEED 5] The refetch runs in the background: the button is free at the
 *  server's answer, and what that answer itself says (the saved contact, the
 *  verification time, the removal) is in the list at once. Nothing the server
 *  did not answer is ever written: a verified badge appears only from a
 *  verification time the server sent. */
function useContactMutation<TArg, TRes>(
  fn: (arg: TArg) => Promise<TRes>,
  write?: (list: EmergencyContact[], answer: TRes, arg: TArg) => EmergencyContact[],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (answer: TRes, arg: TArg) => {
      if (write) {
        qc.setQueryData<EmergencyContact[]>(emergencyContactKeys.all, (list) => (Array.isArray(list) ? write(list, answer, arg) : list));
      }
      void qc.invalidateQueries({ queryKey: emergencyContactKeys.all });
    },
  });
}

/** [APP-SPEED 5] The contact list after each answer (pure; exported for the tests). */
export const contactListAfter = {
  added(list: EmergencyContact[], answer: unknown): EmergencyContact[] {
    const a = answer as (Partial<EmergencyContact> & { codeSent?: unknown }) | null | undefined;
    if (typeof a?.id !== 'string' || !a.id || typeof a.name !== 'string' || typeof a.phoneE164 !== 'string') return list;
    if (list.some((c) => c.id === a.id)) return list;
    const contact: Record<string, unknown> = { verifiedAt: null, ...a };
    delete contact['codeSent'];
    return [...list, contact as unknown as EmergencyContact];
  },
  verified(list: EmergencyContact[], response: unknown): EmergencyContact[] {
    const a = (response as { data?: { data?: { id?: unknown; verifiedAt?: unknown } } } | null | undefined)?.data?.data;
    if (typeof a?.id !== 'string' || typeof a.verifiedAt !== 'string' || !a.verifiedAt) return list;
    return list.map((c) => (c.id === a.id ? { ...c, verifiedAt: a.verifiedAt as string } : c));
  },
  removed(list: EmergencyContact[], id: string): EmergencyContact[] {
    return list.filter((c) => c.id !== id);
  },
};

export function useAddEmergencyContact() {
  return useContactMutation((data: { name: string; phoneE164: string; relationship?: string; priority?: number }) =>
    safetyApi.addEmergencyContact(data).then((r) => r.data?.data as { id: string; codeSent: boolean }),
  (list, answer) => contactListAfter.added(list, answer));
}

export function useVerifyEmergencyContact() {
  return useContactMutation(({ id, code }: { id: string; code: string }) =>
    safetyApi.verifyEmergencyContact(id, code),
  (list, response) => contactListAfter.verified(list, response));
}

export function useResendEmergencyContactCode() {
  return useContactMutation((id: string) => safetyApi.resendEmergencyContactCode(id));
}

export function useRemoveEmergencyContact() {
  return useContactMutation((id: string) => safetyApi.removeEmergencyContact(id),
    (list, _answer, id) => contactListAfter.removed(list, id));
}

export interface LivenessCheckOutcome {
  checkId: string;
  outcome: 'PASS' | 'BORDERLINE' | 'FAIL' | 'ERROR_FAIL_OPEN' | 'ERROR_FAIL_CLOSED';
  allowedOnline: boolean;
  attemptsLeft?: number;
}

/** §7.1 — run one shift identity check. The screen renders every outcome
 *  itself (including the 423 lock), so the global error toast stays out. */
/**
 * [TST-001] The driver's answer to a Trip Guardian check.
 *
 * The push that asks carries the cycle and a nonce; the server treats the
 * nonce as the identity of the question, so a retry after a dropped
 * connection answers the same question rather than a new one.
 */
export function useGuardianDriverConfirm() {
  return useMutation({
    mutationFn: async ({ cycleId, nonce }: { cycleId: string; nonce: string }) => {
      const res = await safetyApi.guardianDriverConfirm({ cycleId, nonce });
      return res.data?.data as { status?: string } | undefined;
    },
    meta: { silent: true },
  });
}

export function useLivenessCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ photoUri, profile }: { photoUri: string; profile: 'DRIVER' | 'RIDER' }) => {
      const form = new FormData();
      const owner = requireAuthSessionSnapshot();
      form.append('file', await prepareUploadImage({ uri: photoUri, name: 'liveness.jpg', type: 'image/jpeg' }) as never);
      const current = requireAuthSessionForPrincipal(owner);
      const res = await safetyApi.livenessCheck(form, profile, current);
      requireAuthSessionForPrincipal(owner);
      return res.data?.data as LivenessCheckOutcome;
    },
    // A pass changes what go-online will say — refetch the mover surface.
    // [APP-SPEED 5] In the background: the screen shows this check's own outcome from the answer.
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['mover'] }); },
    meta: { silent: true },
  });
}
