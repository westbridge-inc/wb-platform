import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// [Review A S4-D on #2502] assertClearOfParties' `reviewOfStaffDecisionBy` lifts the "a staff party goes to a
// SUPER_ADMIN" rule for ONE named decider. It exists for a second person's review of a staff member's own decision,
// a review that moves no money. This census keeps it there: a money door (a credit, a refund, a reversal, a payout)
// never passes it. A new caller must be added below on purpose, with its reason.
// ---------------------------------------------------------------------------

const SRC = path.join(__dirname, '..');
const OPTION = 'reviewOfStaffDecisionBy';

/** Every caller allowed to pass the option, and the one function it is passed from. */
const ALLOWED: Record<string, { fn: string; why: string }> = {
  'modules/billing/mmg-checkout.service.ts': {
    fn: 'async reviewOwnerLateCredit(',
    why: 'the second person’s review of the owner’s late MMG credit: it writes only the review record and an audit row',
  },
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sources(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('[Review A S4-D] the review-only staff exemption of assertClearOfParties', () => {
  const users = sources(SRC)
    .map((file) => ({ rel: path.relative(SRC, file).split(path.sep).join('/'), text: readFileSync(file, 'utf8') }))
    .filter(({ rel, text }) => rel !== 'modules/integrity/party-authority.ts' && text.includes(OPTION));

  it('is passed only by the callers listed here', () => {
    expect(users.map((u) => u.rel).sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('is passed once per listed caller, from its review function, which moves no money', () => {
    for (const { rel, text } of users) {
      const allowed = ALLOWED[rel]!;
      expect(text.split(OPTION).length - 1, rel).toBe(1);
      const start = text.indexOf(allowed.fn);
      expect(start, `${rel}: ${allowed.fn}`).toBeGreaterThanOrEqual(0);
      // The function's body, up to the next class member at the same indentation.
      const end = text.indexOf('\n  }\n', start);
      const body = text.slice(start, end);
      expect(body.includes(OPTION), `${rel}: passed from ${allowed.fn}`).toBe(true);
      // No money is moved there: no top-up, no settlement, no provider identity, no checkout status written.
      for (const money of ['recordTopUp', 'markSettlementApplying', 'claimProviderPayment', 'mmgCheckoutIntent.update', 'reverseTransaction', 'this.confirm(']) {
        expect(body.includes(money), `${rel}: ${allowed.fn} must move no money (${money})`).toBe(false);
      }
    }
  });
});
