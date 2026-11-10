import type { AuthorityLetter } from './authority-letter';
import { PrintButton } from './print-button';

/** [COMPANY-DOCS · owner 10 Nov 2026 (a)] One letter on one printed page: the steps above it never print. */
export function AuthorityLetterPage({ letter }: { letter: AuthorityLetter }) {
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-2xl bg-white px-4 py-8 text-[15px] leading-relaxed text-black print:max-w-none print:p-0">
      <section className="mb-8 rounded-2xl border border-black/10 p-4 print:hidden" aria-labelledby="letter-howto">
        <h1 id="letter-howto" className="text-lg font-bold">{letter.title}</h1>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
          {letter.howTo.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <PrintButton />
      </section>
      <article data-letter={letter.kind} aria-label={letter.title}>
        <h2 className="mb-6 text-base font-bold uppercase tracking-wide">{letter.title}</h2>
        {letter.lines.map((line) => (
          <p key={line.text} className={line.gap ? 'mb-5' : 'mb-2'}>
            {line.text}
            {line.blank ? <span className="ml-2 inline-block w-64 border-b border-black align-bottom" aria-hidden="true">&nbsp;</span> : null}
          </p>
        ))}
        <div className="mt-10 space-y-8">
          {letter.signature.map((label) => (
            <p key={label} className="flex items-end gap-3">
              <span className="shrink-0">{label}:</span>
              <span className="inline-block h-6 flex-1 border-b border-black" aria-hidden="true" />
            </p>
          ))}
        </div>
      </article>
    </main>
  );
}
