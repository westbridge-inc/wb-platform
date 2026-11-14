import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screenWakeLock, useScreenWakeLock } from './wake-lock';

// ---------------------------------------------------------------------------
// [STORE-BOARD · parity audit C4, owner 14 Nov 2026] A counter tablet on the website keeps its screen on while the
// order board is open: the browser's Screen Wake Lock, asked for again when the tab comes back (the browser drops it
// whenever the tab is hidden), released when the board closes. No wake lock, or a refusal: normal sleep, no error.
// ---------------------------------------------------------------------------

function fakeWakeLock(refuse = false) {
  const sentinels: Array<{ released: boolean; release: ReturnType<typeof vi.fn> }> = [];
  const request = vi.fn(async (type: string) => {
    if (refuse) throw new Error('NotAllowedError');
    expect(type).toBe('screen');
    const s = { released: false, release: vi.fn(async () => { s.released = true; }) };
    sentinels.push(s);
    return s;
  });
  vi.stubGlobal('navigator', { ...navigator, wakeLock: { request } });
  return { request, sentinels };
}
function visibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}
function Board({ on }: { on: boolean }) { useScreenWakeLock(on); return null; }

afterEach(() => { vi.unstubAllGlobals(); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); });

describe('[STORE-BOARD C4] the website board keeps the screen on', () => {
  it('asks for the screen lock while the board is shown, and releases it when the board closes', async () => {
    const lock = fakeWakeLock();
    const view = render(<Board on />);
    await act(async () => {});
    expect(lock.request).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(lock.sentinels[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('asks again when the tab comes back (the browser dropped it while hidden), never twice while held', async () => {
    const lock = fakeWakeLock();
    render(<Board on />);
    await act(async () => {});
    await act(async () => { visibility('visible'); });
    expect(lock.request).toHaveBeenCalledTimes(1);
    lock.sentinels[0]!.released = true; // the browser let go while the tab was hidden
    await act(async () => { visibility('hidden'); });
    expect(lock.request).toHaveBeenCalledTimes(1);
    await act(async () => { visibility('visible'); });
    expect(lock.request).toHaveBeenCalledTimes(2);
  });

  it('off: nothing is asked', async () => {
    const lock = fakeWakeLock();
    render(<Board on={false} />);
    await act(async () => {});
    expect(lock.request).not.toHaveBeenCalled();
  });

  it('a browser without it, or one that refuses: nothing breaks', async () => {
    vi.stubGlobal('navigator', { userAgent: 'old' });
    expect(screenWakeLock()).toBeNull();
    expect(() => render(<Board on />)).not.toThrow();
    const lock = fakeWakeLock(true);
    render(<Board on />);
    await act(async () => {});
    expect(lock.request).toHaveBeenCalled();
  });
});
