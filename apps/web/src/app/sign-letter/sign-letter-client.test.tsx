import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignLetterClient, parseLetterLink } from './sign-letter-client';
import robots from '../robots';

// [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] The page a director (or a business's owner) opens from Swift's text:
// read the one-page letter, confirm a code texted to their phone, sign with a finger and tick "I authorise". No account.
// The link's secret is after the '#': it leaves the address bar once read and goes to the API only in request bodies.

// A link secret's shape (43 URL-safe characters), plainly fake: never a real-looking key.
const TOKEN = 'test-link-token-'.padEnd(43, 'x');
const PAGE = {
  status: 'SENT', title: 'Letter of authority: Swift store account (company)', signerKind: 'director', signerName: 'Devon Persaud',
  phoneEnding: '123', expiresAt: '2026-11-13T15:00:00.000Z', signedAt: null,
  lines: ['To: Westbridge Inc. (Swift), Georgetown', 'Date: 10 November 2026', 'Company: Kariba Fried Chicken Ltd.', 'I, Devon Persaud, a director of Kariba Fried Chicken Ltd., confirm that the company authorises Asha Ramdin (Operations Manager) to open and manage the company’s Swift store account for it.'],
};

const at = (hash: string) => window.history.replaceState(null, '', `/sign-letter${hash}`);
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
const refused = (status: number, message: string) => new Response(JSON.stringify({ success: false, error: { code: 'X', message } }), { status });
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

beforeEach(() => {
  // happy-dom draws nothing: a canvas that answers a picture is enough to prove the page sends what was drawn
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,iVBORw0KGgoDRAWN');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); at(''); });

describe('the link', () => {
  it('is 43 URL-safe characters after the #, nothing else', () => {
    expect(parseLetterLink(`#${TOKEN}`)).toBe(TOKEN);
    expect(parseLetterLink('')).toBeNull();
    expect(parseLetterLink('#short')).toBeNull();
    expect(parseLetterLink(`#${TOKEN}<script>`)).toBeNull();
  });

  it('robots never crawl it (a bearer link)', () => {
    const rules = robots().rules as { disallow: string[] }[];
    expect(rules[0]!.disallow).toContain('/sign-letter');
  });
});

describe('the signing page', () => {
  it('read → code → sign: the letter’s exact words, a code to the number ending …123, a drawn signature and the tick', async () => {
    at(`#${TOKEN}`);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok(PAGE))
      .mockResolvedValueOnce(ok({ phoneEnding: '123', expiresInSeconds: 600 }))
      .mockResolvedValueOnce(ok({ signingKey: 'K'.repeat(43), expiresInSeconds: 1800 }))
      .mockResolvedValueOnce(ok({ status: 'SIGNED', signedAt: '2026-11-11T13:00:00.000Z' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<SignLetterClient />);
    expect(await screen.findByRole('heading', { name: PAGE.title })).toBeTruthy();
    for (const line of PAGE.lines) expect(screen.getByText(line)).toBeTruthy();
    expect(window.location.hash).toBe(''); // the secret left the address bar once read
    // no signature before the code
    expect(screen.queryByRole('img', { name: 'Signature of Devon Persaud' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Text me a code' }));
    await user.type(await screen.findByLabelText('Code'), '482913');
    await user.click(screen.getByRole('button', { name: 'Confirm code' }));
    const pad = await screen.findByRole('img', { name: 'Signature of Devon Persaud' });
    const sign = screen.getByRole('button', { name: 'Sign the letter' }) as HTMLButtonElement;
    expect(sign.disabled).toBe(true); // nothing drawn, nothing ticked
    fireEvent.pointerDown(pad, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(pad, { clientX: 60, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(pad, { clientX: 60, clientY: 40, pointerId: 1 });
    expect(sign.disabled).toBe(true); // drawn, not ticked
    await user.click(screen.getByRole('checkbox', { name: /I, Devon Persaud, authorise what this letter says, as a director of the company, and sign it\./ }));
    expect(sign.disabled).toBe(false);
    await user.click(sign);
    expect(await screen.findByText('Signed. Thank you, Devon.')).toBeTruthy();
    const calls = fetchMock.mock.calls;
    expect(calls.map((c) => String(c[0]).replace(/^.*\/api\/v1\/public\/authority-letter\//, ''))).toEqual(['open', 'code', 'verify', 'sign']);
    // the secret never rides in a URL, and no session rides along
    for (const c of calls) {
      expect(String(c[0])).not.toContain(TOKEN);
      expect((c[1] as RequestInit).credentials).toBeUndefined();
    }
    expect(bodyOf(calls[0]!)).toEqual({ token: TOKEN });
    expect(bodyOf(calls[2]!)).toEqual({ token: TOKEN, code: '482913' });
    expect(bodyOf(calls[3]!)).toEqual({ token: TOKEN, signingKey: 'K'.repeat(43), signature: 'data:image/png;base64,iVBORw0KGgoDRAWN', agree: true });
  });

  it('a wrong code says the server’s words and keeps the signature locked', async () => {
    at(`#${TOKEN}`);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(ok(PAGE))
      .mockResolvedValueOnce(ok({ phoneEnding: '123', expiresInSeconds: 600 }))
      .mockResolvedValueOnce(refused(400, 'That code isn’t right. 4 tries left.')));
    const user = userEvent.setup();
    render(<SignLetterClient />);
    await user.click(await screen.findByRole('button', { name: 'Text me a code' }));
    await user.type(await screen.findByLabelText('Code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Confirm code' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That code isn’t right. 4 tries left.');
    expect(screen.queryByRole('img', { name: /Signature/ })).toBeNull();
  });

  it('an expired, used or unknown link says so, and a link without its secret asks for the whole link', async () => {
    at(`#${TOKEN}`);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(refused(410, 'This link has expired. Ask the person who sent it to send you a new one from Swift.')));
    render(<SignLetterClient />);
    expect(await screen.findByText('This link has expired. Ask the person who sent it to send you a new one from Swift.')).toBeTruthy();
  });

  it('an already signed letter is not offered again', async () => {
    at(`#${TOKEN}`);
    // [review F4] a signed link answers only that it is signed
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(ok({ status: 'SIGNED', signedAt: '2026-11-11T13:00:00.000Z' })));
    render(<SignLetterClient />);
    expect(await screen.findByText('This letter is already signed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Text me a code' })).toBeNull();
  });

  it('no secret: nothing is asked of the server', async () => {
    at('');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<SignLetterClient />);
    expect(await screen.findByText('This link is not complete')).toBeTruthy();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
