import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [APP-SPEED 5 · 7 Nov 2026] Buttons answer at the server's reply: what the answer says goes on screen at once,
// the re-read runs in the background (`void`), and the button is free (the callback returns nothing to wait for).
// The REAL hooks' options against a REAL query client; the network, the account and the stores are stand-ins.
// Money confirmations keep their wait: __tests__/buttons-free-at-the-answer.census.test.ts.
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient }));
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...real, useMutation: (o: unknown) => o, useQuery: (o: unknown) => o, useQueryClient: () => fx.qc };
});
vi.mock('../services/api', () => ({ servicesApi: {}, safetyApi: {}, vendorApi: {}, vendorDiscoveryApi: {} }));
vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { id: 'u1' }, sessionGeneration: 1 }),
  getAuthSessionSnapshot: () => ({ userId: 'u1', generation: 1 }),
  requireAuthSessionSnapshot: () => ({ userId: 'u1', generation: 1 }),
  requireAuthSessionForPrincipal: () => ({ userId: 'u1', generation: 1 }),
}));
vi.mock('../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../lib/uploadImage', () => ({ prepareUploadImage: vi.fn() }));
vi.mock('../lib/sosKey', () => ({ createSosKeyStore: () => ({}) }));
vi.mock('../stores/storeSwitcher', () => {
  const state = () => ({ selectedStoreId: 'store-a', storeGeneration: 1 });
  return { useStoreSwitcher: Object.assign((selector: (s: unknown) => unknown) => selector(state()), { getState: state }) };
});
vi.mock('../stores/vendorPreview', () => ({ useVendorPreview: { getState: () => ({ previewType: null }) } }));
vi.mock('../lib/vendorPreviewData', () => ({ previewMutation: () => ({}) }));

import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { jobsWithAnswer, useCancelJob, useCompleteJob, useConfirmJob, useQuoteJob, useRateJob, useScheduleJob, useStartJob, useDeclineSlot } from './services';
import { contactListAfter, emergencyContactKeys, useAddEmergencyContact, useRemoveEmergencyContact, useVerifyEmergencyContact, type EmergencyContact } from './safety';
import { useUpdateStoreVat } from './storeVat';

type Opts = { onSuccess?: (...a: unknown[]) => unknown; onSettled?: (...a: unknown[]) => unknown };

beforeEach(() => { fx.qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { fx.qc.clear(); });

async function observed(key: unknown[], value: unknown) {
  fx.qc.setQueryData(key, value);
  const read = vi.fn(async () => fx.qc.getQueryData(key));
  const off = new QueryObserver(fx.qc, { queryKey: key, queryFn: read, staleTime: Infinity }).subscribe(() => {});
  return { read, off };
}

describe('[APP-SPEED 5] a pro job step writes the job the server answered', () => {
  const row = { id: 'job-1', status: 'REQUESTED', updatedAt: '2026-11-07T10:00:00.000Z', description: 'Fix the tap', appointment: { canMove: true }, customerCancel: { free: true } };
  const steps: Array<[string, () => Opts]> = [
    ['quote', () => useQuoteJob() as unknown as Opts], ['schedule', () => useScheduleJob() as unknown as Opts],
    ['confirm', () => useConfirmJob() as unknown as Opts], ['decline the slot', () => useDeclineSlot() as unknown as Opts],
    ['start', () => useStartJob() as unknown as Opts], ['complete', () => useCompleteJob() as unknown as Opts],
    ['cancel', () => useCancelJob() as unknown as Opts],
  ];
  for (const [name, hook] of steps) {
    it(`${name}: free at the answer; the row is the answered job, with its new updatedAt for the next tap`, async () => {
      const list = await observed(['services', 'jobs'], [row, { id: 'job-2', status: 'QUOTED', updatedAt: 'x' }]);
      const answer = { id: 'job-1', status: 'QUOTED', updatedAt: '2026-11-07T10:05:00.000Z', quoteAmount: '5000.00' };
      const returned = hook().onSettled!(answer, null, { id: 'job-1' });
      expect(returned, 'the button is not held for the re-read').toBeUndefined();
      const rows = fx.qc.getQueryData(['services', 'jobs']) as Array<Record<string, unknown>>;
      expect(rows[0]).toEqual({ id: 'job-1', status: 'QUOTED', updatedAt: '2026-11-07T10:05:00.000Z', quoteAmount: '5000.00', description: 'Fix the tap' });
      expect(rows[0], 'no move or cancel offer from before the step').not.toHaveProperty('appointment');
      expect(rows[1]).toEqual({ id: 'job-2', status: 'QUOTED', updatedAt: 'x' });
      await vi.waitFor(() => expect(list.read).toHaveBeenCalledTimes(1));
      list.off();
    });
  }

  it('a refused step (no answer) writes nothing and still re-reads, free at once', async () => {
    const list = await observed(['services', 'jobs'], [row]);
    const returned = (useQuoteJob() as unknown as Opts).onSettled!(undefined, new Error('409'), { id: 'job-1' });
    expect(returned).toBeUndefined();
    expect(fx.qc.getQueryData(['services', 'jobs'])).toEqual([row]);
    await vi.waitFor(() => expect(list.read).toHaveBeenCalledTimes(1));
    list.off();
  });

  it('a rating (its answer is the rating, not the job) writes nothing, free at once', async () => {
    const list = await observed(['services', 'jobs'], [row]);
    expect((useRateJob() as unknown as Opts).onSuccess!({ id: 'rating-1', score: 5 })).toBeUndefined();
    expect(fx.qc.getQueryData(['services', 'jobs'])).toEqual([row]);
    list.off();
  });

  it('[review S3.2] a reply older than the row the list already holds is not written over it; equal or newer is', () => {
    const newer = { ...row, status: 'SCHEDULED', updatedAt: '2026-11-07T10:10:00.000Z' };
    expect(jobsWithAnswer([newer], { id: 'job-1', status: 'QUOTED', updatedAt: '2026-11-07T10:05:00.000Z' })).toEqual([newer]);
    const same = jobsWithAnswer([newer], { id: 'job-1', status: 'SCHEDULED', updatedAt: '2026-11-07T10:10:00.000Z', quoteAmount: '1' }) as Array<Record<string, unknown>>;
    expect(same[0]).toMatchObject({ quoteAmount: '1' });
    const later = jobsWithAnswer([newer], { id: 'job-1', status: 'IN_PROGRESS', updatedAt: '2026-11-07T10:20:00.000Z' }) as Array<Record<string, unknown>>;
    expect(later[0]).toMatchObject({ status: 'IN_PROGRESS', updatedAt: '2026-11-07T10:20:00.000Z' });
    expect(jobsWithAnswer([newer], { id: 'job-1', status: 'QUOTED', updatedAt: 'not a time' }), 'an unreadable reply time never overwrites').toEqual([newer]);
  });

  it('only a job answer is written (id, status, updatedAt)', () => {
    expect(jobsWithAnswer([row], { id: 'job-1' })).toEqual([row]);
    expect(jobsWithAnswer([row], { status: 'QUOTED', updatedAt: 'y' })).toEqual([row]);
    expect(jobsWithAnswer(undefined, { id: 'job-1', status: 'QUOTED', updatedAt: 'y' })).toBeUndefined();
  });
});

describe('[APP-SPEED 5] emergency contacts: what the answer says, at once', () => {
  const mum: EmergencyContact = { id: 'c1', name: 'Mum', phoneE164: 'phone-1', priority: 1, verifiedAt: null };

  it('added: the saved contact joins the list, not verified; free at the answer', async () => {
    const list = await observed([...emergencyContactKeys.all], [mum]);
    const returned = (useAddEmergencyContact() as unknown as Opts).onSuccess!(
      { id: 'c2', name: 'Dad', phoneE164: 'phone-2', relationship: null, priority: 2, verifiedAt: null, codeSent: true }, {});
    expect(returned).toBeUndefined();
    expect(fx.qc.getQueryData(emergencyContactKeys.all)).toEqual([mum, { id: 'c2', name: 'Dad', phoneE164: 'phone-2', relationship: null, priority: 2, verifiedAt: null }]);
    await vi.waitFor(() => expect(list.read).toHaveBeenCalledTimes(1));
    list.off();
  });

  it('the list rules: a verified badge only from the server\'s verification time; a removal drops the row', () => {
    expect(contactListAfter.added([mum], { id: 'c2', name: 'Dad', phoneE164: 'phone-2', priority: 2, verifiedAt: null, codeSent: true }))
      .toEqual([mum, { id: 'c2', name: 'Dad', phoneE164: 'phone-2', priority: 2, verifiedAt: null }]);
    expect(contactListAfter.added([mum], { id: 'c2', codeSent: true }), 'an answer without the contact adds no blank row').toEqual([mum]);
    expect(contactListAfter.verified([mum], { data: { data: { id: 'c1', verifiedAt: '2026-11-07T10:00:00.000Z' } } }))
      .toEqual([{ ...mum, verifiedAt: '2026-11-07T10:00:00.000Z' }]);
    expect(contactListAfter.verified([mum], { data: { data: { id: 'c1', verifiedAt: null } } })).toEqual([mum]);
    expect(contactListAfter.verified([mum], undefined)).toEqual([mum]);
    expect(contactListAfter.removed([mum], 'c1')).toEqual([]);
  });

  it('verify and remove are free at the answer and write it into the list the screen reads', async () => {
    const list = await observed([...emergencyContactKeys.all], [mum]);
    expect((useVerifyEmergencyContact() as unknown as Opts).onSuccess!({ data: { data: { id: 'c1', verifiedAt: 'v-time' } } }, { id: 'c1', code: '123456' })).toBeUndefined();
    expect(fx.qc.getQueryData(emergencyContactKeys.all)).toEqual([{ ...mum, verifiedAt: 'v-time' }]);
    expect((useRemoveEmergencyContact() as unknown as Opts).onSuccess!({ data: { data: { deleted: true } } }, 'c1')).toBeUndefined();
    expect(fx.qc.getQueryData(emergencyContactKeys.all)).toEqual([]);
    await vi.waitFor(() => expect(list.read).toHaveBeenCalled());
    list.off();
  });
});

describe('[APP-SPEED 5] the store\'s VAT answer is on screen at the answer', () => {
  it('the answered view is the store\'s VAT read at once; free at the answer; re-read in the background', async () => {
    const key = ['vendor', 'vat', 'store-a', 'u1', 1];
    const read = await observed(key, { status: 'NONE' });
    const returned = (useUpdateStoreVat() as unknown as Opts).onSuccess!({ status: 'PENDING', vatRegistrationNumber: 'VAT-1' });
    expect(returned).toBeUndefined();
    expect(fx.qc.getQueryData(key)).toEqual({ status: 'PENDING', vatRegistrationNumber: 'VAT-1' });
    await vi.waitFor(() => expect(read.read).toHaveBeenCalledTimes(1));
    read.off();
  });

  it('no view in the answer (a preview, an older server): nothing written, still re-read', async () => {
    const key = ['vendor', 'vat', 'store-a', 'u1', 1];
    const read = await observed(key, { status: 'NONE' });
    (useUpdateStoreVat() as unknown as Opts).onSuccess!(undefined);
    expect(fx.qc.getQueryData(key)).toEqual({ status: 'NONE' });
    read.off();
  });
});
