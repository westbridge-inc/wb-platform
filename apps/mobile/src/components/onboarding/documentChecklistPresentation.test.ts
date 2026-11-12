import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checklistProgress, emptyChecklistCopy, faceMatchedDocTypes, optionalDocHint, optionalDocTypes } from './documentChecklistPresentation';

describe('empty verification checklist', () => {
  it('explains a service policy hold without claiming approval or a 24-hour review', () => {
    expect(emptyChecklistCopy({ categoryUnavailable: true })).toEqual({
      title: 'Service checks pending',
      body: 'This service is unavailable while its required checks are prepared. You cannot receive requests yet.',
    });
  });

  it('does not call any other empty checklist complete', () => {
    expect(emptyChecklistCopy({})).toEqual({
      title: 'Verification steps unavailable',
      body: 'We cannot confirm your requirements right now. Try again later.',
    });
  });
});

describe('the face-match line follows the server', () => {
  it('names exactly the documents the server lists', () => {
    expect([...faceMatchedDocTypes({ faceMatchDocTypes: ['owner_national_id'] })]).toEqual(['owner_national_id']);
    expect([...faceMatchedDocTypes({ faceMatchDocTypes: ['national_id', 'owner_national_id'] })]).toEqual(['national_id', 'owner_national_id']);
  });

  it('names none while the server lists none, says nothing, or says something that is not a list of document types', () => {
    for (const status of [
      { faceMatchDocTypes: [] },
      {},
      null,
      undefined,
      { faceMatchDocTypes: true },
      { faceMatchDocTypes: 'owner_national_id' },
      { faceMatchDocTypes: { owner_national_id: true } },
      { faceMatchDocTypes: [1, null, '', { docType: 'owner_national_id' }] },
    ]) {
      expect(faceMatchedDocTypes(status as never).size, JSON.stringify(status)).toBe(0);
    }
  });
});

// [REPLACE-PENDING · owner request 8 Oct 2026] a document waiting for review can be replaced, and says so once replaced.
describe('a document waiting for review', () => {
  it('offers to replace it, and says "Replaced — waiting for review" after', async () => {
    const { pendingDocumentLabel } = await import('./documentChecklistPresentation');
    expect(pendingDocumentLabel(false, '2026-10-08T12:00:00.000Z')).toBe('Submitted 8 Oct — in review · tap to replace');
    expect(pendingDocumentLabel(false, null)).toBe('In review · tap to replace');
    expect(pendingDocumentLabel(true, '2026-10-08T12:00:00.000Z')).toBe('Replaced — waiting for review · tap to replace again');
  });

  it('the card stays tappable while waiting (asks first); only an approved document, or a missing consent tick (R17), locks it', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const card = readFileSync(join(process.cwd(), 'src/components/onboarding/DocumentUploadCard.tsx'), 'utf8');
    // [POLICE-CLEARANCE CONSENT] `canUpload` = the list's tick, or a police clearance's own (uploadConsentCopy.test).
    expect(card).toMatch(/<Pressable disabled=\{approved \|\| upload\.isPending \|\| !canUpload\} onPress=\{pending \? confirmReplace : pick\}>/);
    expect(card).toMatch(/Replace this document\?/);
    const list = readFileSync(join(process.cwd(), 'src/components/onboarding/DocumentChecklist.tsx'), 'utf8');
    // Required AND optional documents both say "Replaced — waiting for review" (a police clearance can be replaced too).
    expect(list.match(/replaced=\{doc\?\.replaced === true\}/g)).toHaveLength(2);
  });
});

describe('[VERIFY-DOCS] optional documents follow the server', () => {
  it('lists exactly the server\'s optional types, after dropping any the checklist already requires', () => {
    expect(optionalDocTypes({ checklist: ['drivers_licence'], optional: ['national_id', 'police_clearance'] })).toEqual(['national_id', 'police_clearance']);
    expect(optionalDocTypes({ checklist: ['national_id'], optional: ['national_id', 'police_clearance'] })).toEqual(['police_clearance']);
    expect(optionalDocTypes({ checklist: [], optional: ['police_clearance', 'police_clearance'] })).toEqual(['police_clearance']);
  });

  it('shows none for an older server (no `optional`) or anything that is not a list of types', () => {
    for (const status of [{}, null, undefined, { optional: true }, { optional: 'police_clearance' }, { optional: [1, null, ''] }]) {
      expect(optionalDocTypes(status as never), JSON.stringify(status)).toEqual([]);
    }
  });

  it('says what the optional police clearance is for, and never that it is required', () => {
    // [VERIFY-DOCS] No screen shows a Police-cleared badge yet: the hint says what really happens, and promises no badge.
    expect(optionalDocHint('police_clearance')).toMatch(/^Optional\. If Swift approves a current one, your account is recorded as police-cleared\./);
    expect(optionalDocHint('police_clearance')).not.toMatch(/badge|profile/i);
    for (const t of ['police_clearance', 'national_id', 'anything']) expect(optionalDocHint(t)).not.toMatch(/required|must/i);
    // [ROLE-DOCS · owner 21 Oct 2026] no mover is offered a second ID, so no line says the licence proves who they are
    expect(optionalDocHint('national_id')).toBe('Optional. Not needed to start working.');
  });
});

// [FOLLOWUPS 11 Nov 2026] One rule for "every required paper is sent and some wait for a person" (the checklist's
// progress line and the mover's in-review status read it).
describe('checklistProgress', () => {
  const d = (docType: string, status: string, createdAt = '2026-11-01T00:00:00Z', expiresAt: string | null = null) => ({ docType, status, createdAt, expiresAt });
  const checklist = ['drivers_licence', 'vehicle_registration'];
  it('in review: all sent, not all approved', () => {
    expect(checklistProgress({ checklist, documents: [d('drivers_licence', 'APPROVED'), d('vehicle_registration', 'PENDING')] }))
      .toEqual({ total: 2, approved: 1, allSubmitted: true, inReview: true });
  });
  it('not in review: a paper missing, sent back, expired (the expiry sweep\'s EXPIRED), or everything approved', () => {
    expect(checklistProgress({ checklist, documents: [d('drivers_licence', 'PENDING')] }).inReview).toBe(false);
    expect(checklistProgress({ checklist, documents: [d('drivers_licence', 'PENDING'), d('vehicle_registration', 'REJECTED')] }).inReview).toBe(false);
    expect(checklistProgress({ checklist, documents: [d('drivers_licence', 'PENDING'), d('vehicle_registration', 'EXPIRED')] }).inReview).toBe(false);
    expect(checklistProgress({ checklist, documents: [d('drivers_licence', 'APPROVED'), d('vehicle_registration', 'APPROVED')] }))
      .toEqual({ total: 2, approved: 2, allSubmitted: true, inReview: false });
  });
  it('a renewal in flight speaks for its step (pending over the approved one); nothing from an empty or odd answer', () => {
    expect(checklistProgress({ checklist, documents: [d('drivers_licence', 'APPROVED', '2026-10-01T00:00:00Z'), d('drivers_licence', 'PENDING'), d('vehicle_registration', 'APPROVED')] }))
      .toMatchObject({ approved: 1, inReview: true });
    for (const status of [null, undefined, {}, { checklist: 'x', documents: 'y' }]) {
      expect(checklistProgress(status as never), JSON.stringify(status)).toEqual({ total: 0, approved: 0, allSubmitted: false, inReview: false });
    }
  });
});

// The checklist screen keeps its own copy of the precedence (the website's parity test pins its words), so this rule
// and that one are pinned to read the same rows the same way.
describe('checklistProgress reads documents as the checklist screen does', () => {
  it('the same precedence and the same "All submitted" rule, in the screen\'s own words', () => {
    const screen = readFileSync(new URL('./DocumentChecklist.tsx', import.meta.url), 'utf8');
    expect(screen).toContain("docs.find((d) => d.status === 'PENDING')");
    expect(screen).toContain("?? docs.find((d) => d.status === 'APPROVED' && (!d.expiresAt || new Date(d.expiresAt) > new Date()))");
    expect(screen).toContain("const allSubmitted = checklist.every((dt) => ['APPROVED', 'PENDING'].includes(latestDoc(dt)?.status));");
    const helper = readFileSync(new URL('./documentChecklistPresentation.ts', import.meta.url), 'utf8');
    expect(helper).toContain("docs.find((d) => d.status === 'PENDING')");
    expect(helper).toContain("?? docs.find((d) => d.status === 'APPROVED' && (!d.expiresAt || new Date(String(d.expiresAt)).getTime() > now))");
  });
});

