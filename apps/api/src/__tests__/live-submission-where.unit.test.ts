/**
 * [COMPANY-DOCS Part 3 · owner rulings 10 Nov 2026 (c), (d)] evidence.ts `liveSubmissionWhere` is the one live-paper rule
 * (the evidence query and the storefront's supplier block both read it). Its OR is the whole rule: a paper counts only
 * when it belongs to no account change, or to a change a person APPROVED (or, read for a decision, to the one change
 * named). A paper filed for a change still waiting, refused or withdrawn must never be live — lose the OR and every such
 * paper would count. The DB suite (account-change.test.ts) proves the same through recordEvidenceFor; this pins the
 * predicate itself, evaluated row by row, with no database.
 */
import { describe, expect, it } from 'vitest';
import { liveSubmissionWhere } from '../modules/verification/evidence';

type ChangeStatus = 'PENDING' | 'APPROVED' | 'REFUSED' | 'WITHDRAWN';
type Row = { accountChangeId: string | null; accountChange: { status: ChangeStatus } | null };

/** A strict reader of the fragment: anything it does not know is an error, never a silent match. */
function matches(where: Record<string, unknown>, row: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') {
      expect(Array.isArray(value), 'OR must be a list').toBe(true);
      return (value as Record<string, unknown>[]).some((branch) => matches(branch, row));
    }
    if (key === 'accountChangeId') return row.accountChangeId === value;
    if (key === 'accountChange') {
      const filter = value as Record<string, unknown>;
      expect(Object.keys(filter)).toEqual(['status']);
      return row.accountChange !== null && row.accountChange.status === filter['status'];
    }
    throw new Error(`liveSubmissionWhere: unexpected key ${key}`);
  });
}

const paperOf = (id: string | null, status?: ChangeStatus): Row => ({ accountChangeId: id, accountChange: id && status ? { status } : null });
const live = (row: Row, withChange?: string) => matches(liveSubmissionWhere(withChange) as Record<string, unknown>, row);

describe('liveSubmissionWhere: a paper waiting for, or refused with, its account change is never live', () => {
  it('a pending change\'s paper is not live', () => {
    expect(live(paperOf('change-1', 'PENDING'))).toBe(false);
  });

  it('a refused or withdrawn change\'s paper is not live', () => {
    expect(live(paperOf('change-1', 'REFUSED'))).toBe(false);
    expect(live(paperOf('change-1', 'WITHDRAWN'))).toBe(false);
  });

  it('naming a DIFFERENT change lends nothing to a pending or refused one', () => {
    expect(live(paperOf('change-1', 'PENDING'), 'change-2')).toBe(false);
    expect(live(paperOf('change-1', 'REFUSED'), 'change-2')).toBe(false);
  });

  it('a paper of no change, or of an approved change, is live; the change named for its decision counts its own papers', () => {
    expect(live(paperOf(null))).toBe(true);
    expect(live(paperOf('change-1', 'APPROVED'))).toBe(true);
    expect(live(paperOf('change-1', 'PENDING'), 'change-1')).toBe(true);
  });

  it('the rule is a single OR (so it can be spread next to other submission filters without clobbering them)', () => {
    expect(Object.keys(liveSubmissionWhere())).toEqual(['OR']);
    expect(Object.keys(liveSubmissionWhere('change-1'))).toEqual(['OR']);
  });
});
