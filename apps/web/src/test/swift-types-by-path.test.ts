import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// [#2412 REVIEW-2 F5] What the website downloads. `@swift/types` ships its
// TypeScript source, and its index re-exports every module; a VALUE imported
// through the index brings the whole index into a chunk every store-console
// page loads (the dashboard/weekly-fee pages sat 0 kB under their ceilings).
// The website and the phone files it reuses import values BY PATH
// ('@swift/types/src/<module>'), as evidence-reference.ts set out; through the
// index only types (`import type`, erased at build). Measured on 8 Nov 2026:
// dashboard/weekly-fee/pay-all 153.0 -> 151.2 kB, weekly-fee 159.3 -> 157.5 kB.
// ---------------------------------------------------------------------------

const WEB_SRC = resolve(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Every import statement naming the package index, with whether it is types only. */
function barrelValueImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const m of text.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+'@swift\/types'/gm)) {
    if (m[1]) continue;
    const names = (m[2] ?? '').replace(/^\{|\}$/g, '').split(',').map((n) => n.trim()).filter(Boolean);
    if (names.some((n) => !n.startsWith('type '))) found.push(m[0]);
  }
  for (const m of text.matchAll(/^(?:export\s+\*\s+from|import)\s+'@swift\/types'/gm)) found.push(m[0]);
  return found;
}

/** The phone’s own files the website imports (relative paths into apps/mobile/src), and every file they import in turn (relative, non-type imports). */
function reusedPhoneFiles(webFiles: string[]): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  const resolveTs = (from: string, spec: string) => {
    const base = resolve(dirname(from), spec);
    return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find((p) => existsSync(p));
  };
  for (const file of webFiles) {
    for (const m of readFileSync(file, 'utf8').matchAll(/from\s+'(\.[^']*mobile\/src\/[^']+)'/g)) {
      const hit = resolveTs(file, m[1]!);
      if (hit && !seen.has(hit)) { seen.add(hit); queue.push(hit); }
    }
  }
  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const m of readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(\.{1,2}\/[^']+)'/gm)) {
      const hit = resolveTs(file, m[1]!);
      if (hit && !seen.has(hit)) { seen.add(hit); queue.push(hit); }
    }
  }
  return [...seen];
}

describe('[#2412 F5] the website never imports a value through the @swift/types index', () => {
  const web = sources(WEB_SRC);

  it('website files: values by path, types only through the index', () => {
    const offenders = web.flatMap((file) => barrelValueImports(file).map((hit) => `${file.slice(WEB_SRC.length + 1)}: ${hit}`));
    expect(offenders).toEqual([]);
  });

  it('the phone files the website reuses: the same rule (they land in the same chunks)', () => {
    const phone = reusedPhoneFiles(web);
    expect(phone.length).toBeGreaterThan(5);
    const offenders = phone.flatMap((file) => barrelValueImports(file).map((hit) => `${file}: ${hit}`));
    expect(offenders).toEqual([]);
  });
});
