import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ slots: [] as any[], index: 0, userId: 'synthetic-subject', generation: 1,
  api: vi.fn(), request: vi.fn(), logout: vi.fn(), success: vi.fn(), error: vi.fn(), listener: null as null | (() => void),
  order: [] as string[], unregister: vi.fn(), token: 'access-1' }));
vi.mock('react', async (original) => ({ ...await original<object>(),
  useCallback: (fn: any) => fn,
  useState: (initial: unknown) => { const i = h.index++; if (!(i in h.slots)) h.slots[i] = initial; return [h.slots[i], (next: unknown) => { h.slots[i] = next; }]; },
  useRef: (initial: unknown) => { const i = h.index++; return h.slots[i] ??= { current: initial }; },
  useEffect: (fn: () => unknown) => { const i = h.index++; if (!(i in h.slots)) { h.slots[i] = true; fn(); } },
}));
vi.mock('react-native', () => ({ KeyboardAvoidingView: 'KeyboardAvoidingView', ScrollView: 'ScrollView', View: 'View', Share: {}, Platform: { OS: 'ios' } }));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@swift/ui', () => ({ color: { surface: { subtle: '' }, brand: { 50: '', 600: '' }, success: '' }, space: {} }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}), useMutation: (o: any) => ({ mutate: () => o.mutationFn().catch((e: unknown) => { o.onError?.(e); throw e; }) }) }));
vi.mock('../../../hooks/customer', () => ({ useProfile: () => ({ data: { firstName: 'Synthetic', lastName: 'Subject' } }) }));
vi.mock('../../../services/api', () => ({ customerApi: {
  deleteAccount: (...a: unknown[]) => { h.order.push('delete'); return h.api(...a); },
  requestAccountClosure: (...a: unknown[]) => { h.order.push('closure-request'); return h.request(...a); },
} }));
vi.mock('../../../services/callsErase', () => ({ unregisterCallsBeforeAccountEnds: (...a: unknown[]) => { h.order.push('unregister-calls'); return h.unregister(...a); } }));
vi.mock('../../../stores/authStore', () => ({
  AuthSessionBoundaryError: class extends Error {},
  requireAuthSessionSnapshot: () => ({ userId: h.userId, generation: h.generation, accessToken: h.token }),
  requireAuthSessionForPrincipal: (p: any) => { if (p.userId !== h.userId || p.generation !== h.generation) throw new Error('PRINCIPAL_CHANGED'); return { ...p, accessToken: h.token }; },
  useAuthStore: Object.assign((select: any) => select({ logoutIfCurrent: (...a: unknown[]) => { h.order.push('sign-out'); return h.logout(...a); } }), { subscribe: (fn: () => void) => { h.listener = fn; return () => {}; } }),
}));
vi.mock('../../../components/StepUpSheet', () => ({ StepUpSheet: 'StepUpSheet' }));
vi.mock('../../../kit', () => Object.fromEntries(['ErrorState', 'Header', 'IconChip', 'LabeledInput', 'LoadingBlock', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'SettingsRow', 'T'].map((n) => [n, n])));
vi.mock('../../../kit/toast', () => ({ toast: { success: h.success, error: h.error } }));
import { PersonalDataScreen } from './PersonalDataScreen';
const cold = { response: { status: 403, data: { error: { code: 'STEP_UP_REQUIRED' } } } };
function find(node: any, type: string): any {
  if (!node || typeof node !== 'object') return;
  if (node.type === type && (type !== 'PillButton' || ['Delete my account', 'Request account closure'].includes(node.props.label))) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const result = find(child, type); if (result) return result; }
}
function render(closureRequest = false) { h.index = 0; return PersonalDataScreen({ route: { params: { closureRequest } }, navigation: { navigate: vi.fn() } }); }
beforeEach(() => {
  vi.clearAllMocks(); h.slots = []; h.index = 0; h.userId = 'synthetic-subject'; h.generation = 1; h.listener = null;
  h.order = []; h.token = 'access-1'; h.unregister.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// [CALLS-ERASE · legal review F1, 9 Nov 2026] Deleting or closing the account takes this phone out of in-app calls
// FIRST, with the session that is still live. The server revokes every session on a deletion; the sign-out teardown
// that follows can then no longer fetch the removal token (401), and Twilio would keep the phone's push token.
// ---------------------------------------------------------------------------
describe('[CALLS-ERASE] the phone leaves in-app calls before the account does', () => {
  it('delete: unregister with the live session, THEN the deletion, then the local sign-out', async () => {
    h.api.mockResolvedValueOnce({ data: { data: { deleted: true } } });
    await find(render(), 'PillButton').props.onPress();
    expect(h.order).toEqual(['unregister-calls', 'delete', 'sign-out']);
    expect(h.unregister).toHaveBeenCalledOnce();
    expect(h.unregister.mock.calls[0]![0]).toMatchObject({ userId: 'synthetic-subject', generation: 1 });
  });

  it('close (a request the team completes): unregister BEFORE the closure request', async () => {
    h.request.mockResolvedValueOnce({ data: { data: { status: 'CLOSURE_REQUESTED', message: 'Request received' } } });
    await find(render(true), 'PillButton').props.onPress();
    expect(h.order).toEqual(['unregister-calls', 'closure-request']);
    expect(h.logout).not.toHaveBeenCalled();
  });

  it('a security-code retry unregisters again right before the request it sends', async () => {
    // The code sheet can stay open for minutes; the app may register again meanwhile. The retry removes it again.
    h.api.mockRejectedValueOnce(cold).mockResolvedValueOnce({ data: { data: { deleted: true } } });
    const pending = Promise.resolve(find(render(), 'PillButton').props.onPress()).then(() => 'completed', () => 'rejected');
    await vi.waitFor(() => expect(find(render(), 'StepUpSheet')?.props.visible).toBe(true));
    h.token = 'access-2'; // the session's access token was refreshed while the sheet was open
    find(render(), 'StepUpSheet').props.onVerified();
    expect(await pending).toBe('completed');
    expect(h.order).toEqual(['unregister-calls', 'delete', 'unregister-calls', 'delete', 'sign-out']);
    expect(h.unregister.mock.calls[1]![0]).toMatchObject({ accessToken: 'access-2' });
  });

  it('a failed unregister (offline, refused) never stops the deletion', async () => {
    h.unregister.mockResolvedValueOnce(false);
    h.api.mockResolvedValueOnce({ data: { data: { deleted: true } } });
    await find(render(), 'PillButton').props.onPress();
    expect(h.order).toEqual(['unregister-calls', 'delete', 'sign-out']);
    expect(h.error).not.toHaveBeenCalled();
  });

  it('another account signed in meanwhile: nothing is unregistered or deleted for it', async () => {
    h.unregister.mockImplementationOnce(async () => { h.userId = 'different-synthetic-subject'; h.generation += 1; return true; });
    await Promise.resolve(find(render(), 'PillButton').props.onPress()).catch(() => undefined);
    expect(h.order).toEqual(['unregister-calls']);
    expect(h.api).not.toHaveBeenCalled();
  });
});
