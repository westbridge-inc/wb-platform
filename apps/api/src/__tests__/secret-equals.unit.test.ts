import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretEquals } from '../utils/secret-equals';

// [AUDIT-20261113 FABLE-03 S4] The metrics and health-detail tokens are compared in constant time.
describe('[AUDIT-20261113 S4] secretEquals', () => {
  it('matches only the exact secret; a missing side never matches', () => {
    expect(secretEquals('Bearer abc', 'Bearer abc')).toBe(true);
    expect(secretEquals('Bearer abd', 'Bearer abc')).toBe(false);
    expect(secretEquals('Bearer ab', 'Bearer abc')).toBe(false);
    expect(secretEquals(undefined, 'x')).toBe(false);
    expect(secretEquals(['x'], 'x')).toBe(false);
    expect(secretEquals('x', '')).toBe(false);
  });
  it('the two token doors use it, never ===', () => {
    const obs = readFileSync(join(__dirname, '..', 'plugins', 'observability.ts'), 'utf8');
    const app = readFileSync(join(__dirname, '..', 'app.ts'), 'utf8');
    expect(obs).toContain("secretEquals(request.headers.authorization, `Bearer ${token}`)");
    expect(app).toContain("secretEquals(request.headers['x-health-detail'], detailToken)");
    expect(app).not.toMatch(/\['x-health-detail'\] === detailToken/);
  });
  it('the refresh reuse grace is clamped', () => {
    const src = readFileSync(join(__dirname, '..', 'modules', 'auth', 'auth.service.ts'), 'utf8');
    expect(src).toMatch(/Math\.min\(60_000, Math\.max\(0, Number\(process\.env\['REFRESH_REUSE_GRACE_MS'\]/);
  });
});
