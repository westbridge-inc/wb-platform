import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditChangesForReaders } from './audit-redaction';

// [SEC-AUDIT 13 Nov 2026 · F9] Legacy approve rows keep the typed policy in the append-only table; every reader drops it.
describe('auditChangesForReaders', () => {
  const legacy = { docType: 'vehicle_insurance', insurance: { insurerName: 'Some Insurer', policyNumber: 'POL-123', coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true } };

  it('drops the insurer and the policy number from an approve row, and keeps the reviewer\'s checks', () => {
    expect(auditChangesForReaders('APPROVE_VERIFICATION_DOC', legacy)).toEqual({ docType: 'vehicle_insurance', insurance: { coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true } });
    expect(legacy.insurance.policyNumber).toBe('POL-123'); // the stored object is not mutated
  });

  it('leaves every other action and shape exactly as stored', () => {
    expect(auditChangesForReaders('SOME_OTHER_ACTION', legacy)).toBe(legacy);
    for (const shape of [null, undefined, 'text', [1, 2], { docType: 'id_card' }, { insurance: 'x' }]) {
      expect(auditChangesForReaders('APPROVE_VERIFICATION_DOC', shape)).toBe(shape);
    }
  });

  it('is applied by both readers that show `changes`: GET /audit-logs and the custody narrative', () => {
    const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
    expect(src('admin/admin.routes.ts')).toContain('changes: auditChangesForReaders(log.action, log.changes)');
    expect(src('verification/custody.ts')).toContain('auditChangesForReaders(a.action, a.changes)');
  });
});
