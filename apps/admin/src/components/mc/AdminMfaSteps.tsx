'use client';

import { useEffect, useState } from 'react';
import {
  confirmAdminMfaEnrolment,
  confirmAdminMfaReplacement,
  errorCode,
  fetchAdminMfaStatus,
  regenerateAdminRecoveryCodes,
  sendStepUpCode,
  startAdminMfaEnrolment,
  startAdminMfaReplacement,
  verifyAdminMfa,
  verifyStepUpCode,
  type AdminMfaStatus,
} from '@/lib/api';
import { gyDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [AUDIT-20261113 FABLE-03 #2] The authenticator-app step of an admin sign-in, and setting the app up.
//
// - Set up: Swift makes a secret, shown here once as text and as a link an authenticator app opens; the admin
//   types the app's 6-digit code to confirm; ten recovery codes are shown ONCE to write down.
// - Sign in: the 6-digit code from the app, or one recovery code.
// Setting up needs a fresh proof it is the account holder: the sign-in code just used, or a code texted now.
// [REVIEW-2501-A S4-6] Once set up (Security page): new recovery codes, or a move to a new app, each proved by the
// current app code or one recovery code.
// ---------------------------------------------------------------------------

type Stage = 'loading' | 'verify' | 'intro' | 'step-up' | 'enrol' | 'recovery' | 'done' | 'prove';
type Intent = 'codes' | 'replace';

const groups = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

export function AdminMfaSteps({ onDone, mode }: { onDone: () => void; mode: 'sign-in' | 'settings' }) {
  const [stage, setStage] = useState<Stage>('loading');
  const [status, setStatus] = useState<AdminMfaStatus | null>(null);
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [intent, setIntent] = useState<Intent>('codes');
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetchAdminMfaStatus()
      .then((s) => {
        if (!live) return;
        setStatus(s);
        if (!s.enrolled) { setStage('intro'); return; }
        if (mode === 'sign-in' && !s.sessionVerified) { setStage('verify'); return; }
        setStage('done');
        if (mode === 'sign-in') onDone();
      })
      .catch((e) => { if (live) { setError((e as Error).message); setStage('intro'); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per mount; onDone is the caller's navigation
  }, [mode]);

  async function run(work: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const beginEnrolment = () => run(async () => {
    try {
      const started = await startAdminMfaEnrolment();
      setEnrolment(started);
      setCode('');
      setStage('enrol');
    } catch (e) {
      if (errorCode(e) === 'STEP_UP_REQUIRED') {
        await sendStepUpCode();
        setCode('');
        setStage('step-up');
        return;
      }
      throw e;
    }
  });

  const finishStepUp = () => run(async () => {
    await verifyStepUpCode(code.trim());
    setCode('');
    const started = await startAdminMfaEnrolment();
    setEnrolment(started);
    setStage('enrol');
  });

  const confirm = () => run(async () => {
    const done = replacing ? await confirmAdminMfaReplacement(code.trim()) : await confirmAdminMfaEnrolment(code.trim());
    setRecoveryCodes(done.recoveryCodes);
    setCode('');
    setStage('recovery');
  });

  const beginProof = (next: Intent) => { setIntent(next); setUseRecovery(false); setCode(''); setError(null); setStage('prove'); };
  const prove = () => run(async () => {
    const proof = useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() };
    if (intent === 'codes') {
      const done = await regenerateAdminRecoveryCodes(proof);
      setRecoveryCodes(done.recoveryCodes);
      setCode('');
      setStage('recovery');
      return;
    }
    const started = await startAdminMfaReplacement(proof);
    setEnrolment(started);
    setReplacing(true);
    setCode('');
    setStage('enrol');
  });

  const verify = () => run(async () => {
    await verifyAdminMfa(useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() });
    onDone();
  });

  const codeInput = (label: string, numeric: boolean, submit: () => void) => (
    <div>
      <label htmlFor="mfa-code" className="text-xs font-semibold">{label}</label>
      <input
        id="mfa-code"
        type="text"
        autoComplete="one-time-code"
        inputMode={numeric ? 'numeric' : 'text'}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder={numeric ? '000000' : 'XXXXX-XXXXX'}
        autoFocus
        className="mc-input mc-numbers mt-1 text-center tracking-[0.3em]"
      />
    </div>
  );

  return (
    <div className="space-y-4">
      {stage === 'loading' && <p className="mc-muted">Checking your sign-in…</p>}

      {stage === 'verify' && (
        <>
          <p className="mc-muted">{useRecovery ? 'Enter one of your recovery codes. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}</p>
          {codeInput(useRecovery ? 'Recovery code' : 'Authenticator code', !useRecovery, verify)}
          <button onClick={verify} disabled={busy || code.trim().length < 6} className="mc-btn mc-btn-primary w-full">
            {busy ? 'Checking…' : 'Continue'}
          </button>
          <button onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }} className="mc-btn mc-btn-quiet w-full">
            {useRecovery ? 'Use the authenticator app instead' : 'Use a recovery code'}
          </button>
        </>
      )}

      {stage === 'intro' && (
        <>
          <p className="mc-muted">
            {status?.required
              ? 'Mission Control needs an authenticator app as a second step. Set it up now. It takes a minute.'
              : 'Add an authenticator app (for example Google Authenticator or 1Password) as a second step when you sign in.'}
          </p>
          <button onClick={beginEnrolment} disabled={busy} className="mc-btn mc-btn-primary w-full">
            {busy ? 'Starting…' : 'Set up an authenticator app'}
          </button>
          {mode === 'settings' && !status?.required && (
            <button onClick={onDone} className="mc-btn mc-btn-quiet w-full">Not now</button>
          )}
        </>
      )}

      {stage === 'step-up' && (
        <>
          <p className="mc-muted">We texted a code to the phone on your account. Enter it to confirm it is you.</p>
          {codeInput('Code from the text', true, finishStepUp)}
          <button onClick={finishStepUp} disabled={busy || code.trim().length < 6} className="mc-btn mc-btn-primary w-full">
            {busy ? 'Checking…' : 'Confirm'}
          </button>
        </>
      )}

      {stage === 'enrol' && enrolment && (
        <>
          <p className="mc-muted">
            In your authenticator app, add an account and type this key (or open the link on the phone that has the app).
            Then enter the 6-digit code the app shows. This key is shown only now.
          </p>
          <p className="mc-card mc-numbers p-3 text-center text-sm" style={{ wordBreak: 'break-all' }} aria-label="Authenticator key">{groups(enrolment.secret)}</p>
          <p className="text-xs"><a href={enrolment.otpauthUrl} className="underline">Open in an authenticator app</a></p>
          {codeInput('Code from the app', true, confirm)}
          <button onClick={confirm} disabled={busy || code.trim().length < 6} className="mc-btn mc-btn-primary w-full">
            {busy ? 'Checking…' : 'Confirm'}
          </button>
        </>
      )}

      {stage === 'recovery' && (
        <>
          <p className="mc-muted">
            Done. Write down these recovery codes and keep them somewhere safe, away from your phone. Each one signs you in
            once if you lose the app. They are shown only now.
          </p>
          <ul className="mc-card mc-numbers grid grid-cols-2 gap-1 p-3 text-sm" aria-label="Recovery codes">
            {recoveryCodes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <button onClick={onDone} className="mc-btn mc-btn-primary w-full">I have written them down</button>
        </>
      )}

      {stage === 'done' && mode === 'settings' && (
        <>
          <p className="mc-muted">
            An authenticator app is set up{status?.enrolledAt ? ` since ${gyDate(status.enrolledAt)}` : ''}.
            {' '}{status?.recoveryCodesLeft ?? 0} recovery codes left.
          </p>
          <button onClick={() => beginProof('codes')} className="mc-btn w-full">Make new recovery codes</button>
          <button onClick={() => beginProof('replace')} className="mc-btn w-full">Move to a new authenticator app</button>
        </>
      )}

      {stage === 'prove' && (
        <>
          <p className="mc-muted">
            {intent === 'codes'
              ? 'New recovery codes replace all the old ones. First confirm it is you.'
              : 'Moving to a new app stops the old app and the old recovery codes. First confirm it is you.'}
            {' '}{useRecovery ? 'Enter one of your recovery codes (it is used up).' : 'Enter the 6-digit code from your current authenticator app.'}
          </p>
          {codeInput(useRecovery ? 'Recovery code' : 'Authenticator code', !useRecovery, prove)}
          <button onClick={prove} disabled={busy || code.trim().length < 6} className="mc-btn mc-btn-primary w-full">
            {busy ? 'Checking…' : 'Continue'}
          </button>
          <button onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }} className="mc-btn mc-btn-quiet w-full">
            {useRecovery ? 'Use the authenticator app instead' : 'Use a recovery code'}
          </button>
          <button onClick={() => { setCode(''); setError(null); setStage('done'); }} className="mc-btn mc-btn-quiet w-full">Cancel</button>
        </>
      )}

      {error && <p role="alert" className="mc-alert">{error}</p>}
    </div>
  );
}
