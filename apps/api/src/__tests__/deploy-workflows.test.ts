import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [AUD-1 row 303] The web and admin deploy workflows hold the Vercel deploy
// token. They ran `npx vercel`: whatever version the registry called latest at
// deploy time, fetched and run (install scripts included) in the step that had
// the token, which was also passed on the command line. And the dependency
// audit read pnpm-lock.yaml only, never the desktop app's Cargo.lock.
// These tests read the real workflow files.
// ---------------------------------------------------------------------------

const REPO = join(__dirname, '..', '..', '..', '..');
const read = (name: string) => readFileSync(join(REPO, '.github', 'workflows', name), 'utf8');

/** Each `- ` step of a workflow's steps list, as its own text block. */
function steps(workflow: string): string[] {
  return workflow.split(/\n(?= {6}- )/).slice(1);
}

describe.each([
  ['deploy-web.yml', 'apps/web'],
  ['deploy-admin.yml', 'apps/admin'],
])('%s holds the deploy token, so its tool is pinned and the token stays out of argv', (file, app) => {
  const workflow = read(file);
  const all = steps(workflow);
  const install = all.find((s) => s.includes('name: Install the Vercel CLI'));
  const deploy = all.find((s) => s.includes('name: Deploy to Vercel'));

  it('installs the Vercel CLI from the committed lockfile (every dependency pinned + integrity), install scripts off, in a step without the token', () => {
    expect(install).toBeDefined();
    // [SEC-AUDIT 13 Nov 2026 · F18] `npm install vercel@x` pinned the CLI but resolved its ~380 dependencies at
    // deploy time; `npm ci` installs exactly the reviewed lockfile, from the public registry named on the line.
    expect(install).toContain('cp .github/vercel-cli/package.json .github/vercel-cli/package-lock.json .github/vercel-cli/.npmrc "$RUNNER_TEMP/vercel-cli/"');
    expect(install).toMatch(/npm ci --prefix "\$RUNNER_TEMP\/vercel-cli" --ignore-scripts --no-audit --no-fund --registry=https:\/\/registry\.npmjs\.org\/\n/);
    expect(install).not.toMatch(/npm install|secrets\.|VERCEL_TOKEN/);
    expect(all.indexOf(install!)).toBeLessThan(all.indexOf(deploy!));
  });

  it('[SEC-AUDIT F18] runs NO repository install: no dependency\'s install script ever runs in the job that gets the token', () => {
    // `vercel --prod` (no --prebuilt) builds on Vercel, so the job needs no node_modules of the monorepo at all.
    expect(workflow).not.toMatch(/pnpm install|pnpm i\b|npm install|yarn install|pnpm\/action-setup|cache: pnpm/);
    expect(deploy).not.toContain('--prebuilt');
  });

  it('deploys with that installed binary, never a registry fetch, and the token only in the environment', () => {
    expect(deploy).toBeDefined();
    expect(deploy).toContain('"$RUNNER_TEMP/vercel-cli/node_modules/.bin/vercel" --prod');
    expect(deploy).toContain(`working-directory: ${app}`);
    expect(deploy).toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}');
    expect(workflow).not.toMatch(/\bnpx\b|npm exec|pnpm dlx|yarn dlx/);
    expect(workflow).not.toMatch(/--token/);
    // No expression is spliced into a shell line: values reach the script through env.
    const runLines = deploy!.split('\n').filter((l) => !/^\s+[A-Z_]+: \$\{\{/.test(l));
    expect(runLines.join('\n')).not.toContain('${{');
  });

  it('only the deploy step sees a secret; the token never reaches install or build steps', () => {
    for (const step of all) {
      if (step === deploy) continue;
      expect(step, step.split('\n')[0]).not.toMatch(/secrets\./);
    }
  });

  it('least privilege: read-only contents, and the checkout keeps no repository token on disk', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).not.toMatch(/:\s*write\b/);
    const checkout = all.find((s) => s.includes('uses: actions/checkout@'));
    expect(checkout).toContain('persist-credentials: false');
  });
});

describe('[SEC-AUDIT 13 Nov 2026 · F18] the pinned Vercel CLI lockfile', () => {
  const dir = join(REPO, '.github', 'vercel-cli');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as { lockfileVersion: number; packages: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }> };

  it('names one exact vercel version, and the lockfile resolves exactly that', () => {
    expect(Object.keys(pkg.dependencies)).toEqual(['vercel']);
    expect(pkg.dependencies['vercel']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages['']).toMatchObject({ dependencies: { vercel: pkg.dependencies['vercel'] } });
    expect(lock.packages['node_modules/vercel']?.version).toBe(pkg.dependencies['vercel']);
  });

  it('every locked package comes from the public npm registry with an integrity hash', () => {
    const entries = Object.entries(lock.packages).filter(([path, p]) => path !== '' && !p.link);
    expect(entries.length).toBeGreaterThan(50);
    for (const [path, p] of entries) {
      expect(p.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(p.integrity, path).toMatch(/^sha512-/);
    }
    expect(readFileSync(join(dir, '.npmrc'), 'utf8').trim()).toBe('registry=https://registry.npmjs.org/');
  });
});

describe('[SEC-AUDIT 13 Nov 2026 · F6] the dependency scanner is checksum-verified before it runs', () => {
  const ci = read('ci.yml');
  const start = ci.indexOf('name: Security Scan');
  const rest = ci.slice(start);
  const next = rest.search(/\n {2}[a-z][\w-]*:\n/);
  const job = next === -1 ? rest : rest.slice(0, next);
  const fetcherPath = join(REPO, 'scripts', 'fetch-trivy.sh');
  const fetcher = existsSync(fetcherPath) ? readFileSync(fetcherPath, 'utf8') : '';

  it('never pipes a download into tar: the job runs scripts/fetch-trivy.sh, which pins a version and its SHA-256', () => {
    expect(job).not.toMatch(/curl[^\n]*\|\s*tar/);
    expect(job).toContain('bash scripts/fetch-trivy.sh');
    expect(fetcher).toMatch(/^VERSION="\d+\.\d+\.\d+"$/m);
    expect(fetcher).toMatch(/^SHA256="[0-9a-f]{64}"$/m);
    // The hash is checked BEFORE the archive is opened, and a mismatch stops the job.
    const check = fetcher.indexOf('sha256sum -c');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(fetcher.indexOf('tar -xzf'));
    expect(fetcher).toMatch(/checksum mismatch[\s\S]*exit 1/);
    expect(fetcher).toContain('set -euo pipefail');
  });

  it('the scan job\'s checkout keeps no repository token on disk', () => {
    const checkout = job.split(/\n(?= {6}- )/).find((s) => s.includes('uses: actions/checkout@'));
    expect(checkout).toContain('persist-credentials: false');
  });
});

describe('the dependency audit reads the desktop app\'s Cargo.lock too', () => {
  const ci = read('ci.yml');
  const start = ci.indexOf('name: Security Scan');
  const rest = ci.slice(start);
  const next = rest.search(/\n {2}[a-z][\w-]*:\n/);
  const job = next === -1 ? rest : rest.slice(0, next);

  it('scans apps/desktop/src-tauri/Cargo.lock at HIGH+ with a blocking exit code and the scoped ignore file', () => {
    const scan = job.split('\n').find((l) => l.includes('trivy fs') && l.includes('Cargo.lock')) ?? '';
    expect(scan).toContain('--scanners vuln');
    expect(scan).toContain('--severity HIGH,CRITICAL');
    expect(scan).toContain('--exit-code 1');
    expect(scan).toContain('--ignorefile .trivyignore.yaml');
    expect(scan.trim().endsWith('apps/desktop/src-tauri/Cargo.lock')).toBe(true);
    expect(readFileSync(join(REPO, 'apps', 'desktop', 'src-tauri', 'Cargo.lock'), 'utf8')).toContain('[[package]]');
  });
});
