'use client';

import { useEffect, useState } from 'react';
import { SwiftLogo } from '@/components/swift-logo';
import { BROWSER_API_ORIGIN as API_URL } from '@/lib/browser-api-origin';
import { SignaturePad } from './signature-pad';

/** What the API shows of the letter (POST /api/v1/public/authority-letter/open). */
export interface LetterPage {
  status: 'SENT' | 'SIGNED';
  title: string;
  lines: string[];
  signerKind: 'director' | 'owner';
  signerName: string;
  phoneEnding: string;
  expiresAt: string;
  signedAt: string | null;
}

/** The link's secret after the '#': 43 URL-safe characters, nothing else. */
export function parseLetterLink(hash: string): string | null {
  const m = /^#?([A-Za-z0-9_-]{43})$/.exec(hash.trim());
  return m ? m[1]! : null;
}

type Step =
  | { kind: 'loading' }
  | { kind: 'no-link' }
  | { kind: 'closed'; message: string }
  | { kind: 'signed' }
  | { kind: 'read'; page: LetterPage }
  | { kind: 'done'; page: LetterPage };

class LetterError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** One POST to the signing API: the secret travels only in the body, never a URL; no session rides along. */
async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1/public/authority-letter/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
    });
  } catch {
    throw new LetterError('Couldn’t reach Swift. Check your connection and try again.', 0);
  }
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string } } | null;
  if (!res.ok) throw new LetterError(json?.error?.message || 'That didn’t work. Please try again.', res.status);
  return json?.data as T;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'That didn’t work. Please try again.');

/**
 * [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] The page a company's director (or a business's owner) opens from
 * Swift's text: no app, no account. Three steps on their own phone: read the one-page letter (exactly the words that
 * are signed), confirm a code Swift texts to their number, then sign with a finger and tick "I authorise". The link's
 * secret sits after the '#' (never sent to a server as part of an address) and leaves the address bar once read.
 */
export function SignLetterClient() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [signingKey, setSigningKey] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState<'code' | 'verify' | 'sign' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = parseLetterLink(window.location.hash);
    setToken(t);
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!t) { setStep({ kind: 'no-link' }); return; }
    post<LetterPage>('open', { token: t })
      .then((page) => setStep(page.status === 'SIGNED' ? { kind: 'signed' } : { kind: 'read', page }))
      .catch((e: unknown) => setStep({ kind: 'closed', message: errorText(e) }));
  }, []);

  async function sendCode() {
    if (!token) return;
    setBusy('code'); setError(null);
    try { await post('code', { token }); setCodeSent(true); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  async function verify() {
    if (!token) return;
    setBusy('verify'); setError(null);
    try {
      const r = await post<{ signingKey: string }>('verify', { token, code: code.trim() });
      setSigningKey(r.signingKey);
    } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }

  async function sign(page: LetterPage) {
    if (!token || !signingKey || !signature || !agree) return;
    setBusy('sign'); setError(null);
    try {
      await post('sign', { token, signingKey, signature, agree: true });
      setStep({ kind: 'done', page });
    } catch (e) {
      if (e instanceof LetterError && e.status === 403) { setSigningKey(null); setCodeSent(false); setCode(''); }
      setError(errorText(e));
    } finally { setBusy(null); }
  }

  return (
    <main id="main" tabIndex={-1} className="min-h-screen bg-[var(--swift-canvas)] text-[var(--swift-ink)]">
      <header className="border-b border-[var(--swift-border)] bg-[var(--swift-card)] px-6 pb-4 pt-[calc(16px_+_env(safe-area-inset-top))]">
        <div className="mx-auto max-w-xl">
          <SwiftLogo />
          <p className="sw-eyebrow mt-3">Swift · Letter of authority</p>
        </div>
      </header>

      <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 pb-12 pt-6">
        {token === undefined || step.kind === 'loading' ? (
          <p role="status" className="sw-caption">Opening the letter…</p>
        ) : step.kind === 'no-link' ? (
          <div role="alert" className="flex flex-col gap-2">
            <p className="sw-heading">This link is not complete</p>
            <p className="sw-caption">Open the whole link from Swift’s text message on your phone.</p>
          </div>
        ) : step.kind === 'closed' ? (
          <div role="alert" className="flex flex-col gap-2">
            <p className="sw-heading">This letter can’t be signed here</p>
            <p className="sw-caption">{step.message}</p>
          </div>
        ) : step.kind === 'signed' ? (
          <div role="status" className="flex flex-col gap-2">
            <p className="sw-heading">This letter is already signed</p>
            <p className="sw-caption">Thank you. A person at Swift checks it. You can close this page.</p>
          </div>
        ) : step.kind === 'done' ? (
          <div role="status" className="flex flex-col gap-2">
            <p className="sw-heading">Signed. Thank you, {step.page.signerName.split(' ')[0]}.</p>
            <p className="sw-caption">Swift keeps the signed letter with the business’s papers, and a person at Swift checks it. You can close this page.</p>
          </div>
        ) : (
          <>
            <section aria-labelledby="letter-title" className="rounded-2xl border border-[var(--swift-border)] bg-white p-5 text-[15px] leading-relaxed text-black">
              <article data-letter-words>
                <h1 id="letter-title" className="mb-4 text-base font-bold">{step.page.title}</h1>
                {step.page.lines.map((line, i) => <p key={i} className="mb-3">{line}</p>)}
              </article>
              <p className="mt-2 text-xs text-[var(--swift-muted)]">This is the whole letter. Swift adds only your signature and a record of how and when you signed.</p>
            </section>

            <section aria-labelledby="letter-code" className="flex flex-col gap-3 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-4">
              <h2 id="letter-code" className="sw-heading">1. Confirm it’s your phone</h2>
              {signingKey ? (
                <p className="sw-caption" role="status">Code confirmed.</p>
              ) : !codeSent ? (
                <>
                  <p className="sw-caption">Swift texts a 6-digit code to your number ending {step.page.phoneEnding}.</p>
                  <button type="button" className="sw-btn sw-btn-block" disabled={busy !== null} onClick={() => void sendCode()}>
                    {busy === 'code' ? 'Sending…' : 'Text me a code'}
                  </button>
                </>
              ) : (
                <>
                  <label className="flex flex-col gap-1 text-sm">
                    <span>The code we texted to the number ending {step.page.phoneEnding}</span>
                    <input
                      className="sw-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="Code"
                    />
                  </label>
                  <button type="button" className="sw-btn sw-btn-block" disabled={busy !== null || code.length !== 6} onClick={() => void verify()}>
                    {busy === 'verify' ? 'Checking…' : 'Confirm code'}
                  </button>
                  <button type="button" className="sw-link-btn self-start" disabled={busy !== null} onClick={() => void sendCode()}>Text me a new code</button>
                </>
              )}
            </section>

            <section aria-labelledby="letter-sign" className="flex flex-col gap-3 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-4">
              <h2 id="letter-sign" className="sw-heading">2. Sign</h2>
              {signingKey ? (
                <>
                  <SignaturePad label={`Signature of ${step.page.signerName}`} onChange={setSignature} />
                  <label className="flex items-start gap-3 text-sm">
                    <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--swift-red)]" />
                    <span>I, {step.page.signerName}, authorise what this letter says, as the {step.page.signerKind}, and sign it.</span>
                  </label>
                  <button type="button" className="sw-btn sw-btn-block" disabled={busy !== null || !signature || !agree} onClick={() => void sign(step.page)}>
                    {busy === 'sign' ? 'Signing…' : 'Sign the letter'}
                  </button>
                </>
              ) : (
                <p className="sw-caption">Confirm the code first, then sign here with your finger.</p>
              )}
            </section>

            {error ? <div role="alert" className="sw-note sw-note-error">{error}</div> : null}
            <p className="text-xs text-[var(--swift-muted)]">Not expecting this letter? Don’t sign it. Just close this page.</p>
          </>
        )}
      </div>
    </main>
  );
}
