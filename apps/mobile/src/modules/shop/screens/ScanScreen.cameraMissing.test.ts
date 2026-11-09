import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [SCAN · pre-build audit 9 Nov 2026] A phone with no working camera (or one another app holds): expo-camera
// cannot start it and reports onMountError, and the frame used to stay dark with no words. The scanner now says
// what happened and what to do instead.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({ slots: [] as unknown[], index: 0, granted: true }));
vi.mock('react', async (original) => ({ ...await original<object>(),
  useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => { const i = h.index++; if (!(i in h.slots)) h.slots[i] = initial; return [h.slots[i], (next: unknown) => { h.slots[i] = next; }]; },
  useRef: (initial: unknown) => { const i = h.index++; return (h.slots[i] ??= { current: initial }); },
  useEffect: () => undefined,
}));
vi.mock('react-native', () => ({ Linking: { openSettings: vi.fn() }, View: 'View' }));
vi.mock('expo-camera', () => ({ CameraView: 'CameraView', useCameraPermissions: () => [{ granted: h.granted, canAskAgain: true }, vi.fn()] }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({ replace: vi.fn() }) }));
vi.mock('@swift/ui', () => ({ color: { text: { muted: '', primary: '' }, white: '' }, radius: { xl: 0 }, space: {}, withAlpha: () => '' }));
vi.mock('../../../kit', () => ({ CartBar: 'CartBar', useCartBarClearance: () => 0, Header: 'Header', PillButton: 'PillButton', Screen: 'Screen', T: 'T' }));
vi.mock('../../../lib/deepLinkParse', () => ({ destinationForUrl: () => null }));
vi.mock('../../../services/deep-links', () => ({ resolveDestination: vi.fn() }));

import { ScanScreen } from './ScanScreen';

function render() { h.index = 0; return ScanScreen() as any; }
function find(node: any, test: (n: any) => boolean): any {
  if (!node || typeof node !== 'object') return undefined;
  if (test(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, test); if (found) return found; }
  return undefined;
}
function text(node: any): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  return text(node.props?.children);
}

const MESSAGE = 'This phone’s camera isn’t available. Ask the store for the menu link.';

beforeEach(() => { h.slots = []; h.index = 0; h.granted = true; });

describe('[SCAN] a phone whose camera cannot start', () => {
  it('the camera view reports a mount error to the screen', () => {
    const camera = find(render(), (n) => n.type === 'CameraView');
    expect(camera).toBeTruthy();
    expect(typeof camera.props.onMountError).toBe('function');
  });

  it('after a mount error: a plain message instead of a dark frame, and no camera view', () => {
    expect(text(render())).not.toContain(MESSAGE);
    find(render(), (n) => n.type === 'CameraView').props.onMountError({ message: 'Camera could not be started' });
    const tree = render();
    expect(text(tree)).toContain(MESSAGE);
    expect(find(tree, (n) => n.type === 'CameraView')).toBeUndefined();
  });

  it('without camera permission the permission ask still comes first', () => {
    h.granted = false;
    const tree = render();
    expect(text(tree)).not.toContain(MESSAGE);
    expect(text(tree)).toContain('Swift needs the camera');
  });
});
