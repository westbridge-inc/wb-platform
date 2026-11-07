import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [APP-SPEED 5 · 7 Nov 2026] A button is free at the server's answer.
//
// TanStack Query awaits the promise a mutation's onSuccess / onSettled / onError returns before the mutation
// counts as done (query-core mutation.js): a callback that RETURNS a re-read (`() => qc.invalidateQueries(…)`)
// keeps the button spinning for a second round trip (~0.3 s from Guyana) after the server already answered.
// The rule: write what the answer says (setQueryData) and fire the re-read with `void`.
//
// The exceptions are MONEY confirmations, which keep their wait on purpose (the screen shows only what a fresh
// read of the money says): the MMG payment claim, the cash settlements, the weekly-fee billing method, the payout
// link and number, and the substitution decision (it changes what the customer pays). Each is listed below with
// its reason. This census reads every .ts/.tsx file with the TypeScript parser and finds every callback property
// (onSuccess / onSettled / onError) whose arrow returns a re-read. A new one fails; an entry below that no longer
// returns its re-read fails too: a money confirmation must keep waiting.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const CALLBACK = /^(onSuccess|onSettled|onError)$/;
const REREAD = /\.(invalidateQueries|refetchQueries|resetQueries)$/;

/** The money confirmations that keep their wait: `file | enclosing function | callback` → [how many, why]. */
const MONEY_WAITS: Record<string, [number, string]> = {
  'hooks/customer.ts | useClaimMmgPayment | onSettled': [1, 'The MMG payment claim: the order is re-read before the claim counts as done (a timeout can mean it landed).'],
  'hooks/customer.ts | useDecideSubstitution | onSuccess': [1, 'A substitution changes what the customer pays: the order total is shown only from a fresh read.'],
  'hooks/customer.ts | useDecideSubstitution | onError': [1, 'A 409 on a substitution (the swap moved on): the order is re-read before the card can be tapped again.'],
  'hooks/mover.ts | useConfirmCashSettlement | onSuccess': [1, 'The rider\'s half of a cash settlement (money): the ledger is re-read before it counts as done.'],
  'hooks/mover.ts | useSetMoverBillingMethod | onSettled': [1, 'The mover\'s weekly fee (fees): the subscription is re-read before the change counts as done.'],
  'hooks/vendorops.ts | useSetVendorBillingMethod | onSettled': [1, 'The store\'s weekly fee (fees): the subscription is re-read before the change counts as done.'],
  'hooks/vendorops.ts | useConfirmVendorCashSettlement | onSuccess': [1, 'The store\'s half of a cash settlement (money): the ledger is re-read before it counts as done.'],
  'modules/mover/screens/MoverAccountScreen.tsx | MoverAccountScreen | onSuccess': [1, 'The driver\'s MMG pay link is where payouts go: the staged change is shown only from a fresh read.'],
  'modules/vendor/screens/VendorAccountScreen.tsx | VendorAccountScreen | onSuccess': [2, 'The store\'s MMG pay link and MMG number are where payouts go: the staged change is shown only from a fresh read.'],
  // Not money, kept on purpose: the answer is not the shape of the list the screen gates on, so freeing the button
  // before the re-read would leave the filled form armed for a second registration (ads are OFF at launch).
  'hooks/advertiser.ts | useRegisterAdvertiser | onSuccess': [1, 'The register answer is not the advertiser list the screen gates on; the form must not be re-armed before it.'],
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === '__tests__' || d.name === 'node_modules' ? [] : files(p);
    return /\.(ts|tsx)$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) && !d.name.endsWith('.d.ts') ? [p] : [];
  });
}

function returnsReread(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const isReread = (e: ts.Expression | undefined): boolean => {
    let x = e;
    while (x && (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isAwaitExpression(x))) x = x.expression;
    if (!x) return false;
    if (ts.isConditionalExpression(x)) return isReread(x.whenTrue) || isReread(x.whenFalse);
    if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return isReread(x.right);
    if (ts.isCallExpression(x)) {
      const callee = x.expression.getText();
      if (REREAD.test(callee)) return true;
      if (/^Promise\.(all|allSettled)$/.test(callee)) return x.arguments.some((a) => ts.isArrayLiteralExpression(a) && a.elements.some((el) => isReread(el as ts.Expression)));
    }
    return false;
  };
  if (!ts.isBlock(fn.body)) return isReread(fn.body);
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (n !== fn && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))) return; // a nested function's return is not this callback's
    if (ts.isReturnStatement(n) && isReread(n.expression)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}

function enclosingName(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)) && /^[A-Zu]/.test(p.name.text)) return p.name.text;
  }
  return '(module)';
}

function census(): Map<string, number> {
  const hits = new Map<string, number>();
  for (const file of files(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!/on(Success|Settled|Error)/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && CALLBACK.test(n.name.text)
        && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) && returnsReread(n.initializer)) {
        const key = `${relative(SRC, file)} | ${enclosingName(n)} | ${n.name.text}`;
        hits.set(key, (hits.get(key) ?? 0) + 1);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return hits;
}

describe('[APP-SPEED 5] a mutation callback never holds the button for a re-read, except a money confirmation', () => {
  const found = census();

  it('every callback that returns a re-read is a listed money confirmation (anything else: write the answer, `void` the re-read)', () => {
    const unexpected = [...found.keys()].filter((key) => !(key in MONEY_WAITS));
    expect(unexpected).toEqual([]);
  });

  it('every listed money confirmation still waits for its re-read, as many times as listed', () => {
    const counts = Object.fromEntries(Object.keys(MONEY_WAITS).map((key) => [key, found.get(key) ?? 0]));
    expect(counts).toEqual(Object.fromEntries(Object.entries(MONEY_WAITS).map(([key, [n]]) => [key, n])));
  });

  it('the scanner sees a returned re-read in every shape (control)', () => {
    const probe = ts.createSourceFile('probe.ts', [
      'function useA() { return useMutation({ onSuccess: () => qc.invalidateQueries({ queryKey: ["a"] }) }); }',
      'function useB() { return useMutation({ onSettled: (d) => { return qc.invalidateQueries({ queryKey: ["b"] }); } }); }',
      'function useC() { return useMutation({ onError: (e) => { if (e) return qc.invalidateQueries({ queryKey: ["c"] }); return undefined; } }); }',
      'function useD() { return useMutation({ onSuccess: () => { void qc.invalidateQueries({ queryKey: ["d"] }); } }); }',
      'function useE() { return useMutation({ onSuccess: () => { const f = () => qc.invalidateQueries({}); f(); } }); }',
    ].join('\n'), ts.ScriptTarget.Latest, true);
    const seen: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && CALLBACK.test(n.name.text) && ts.isArrowFunction(n.initializer) && returnsReread(n.initializer)) seen.push(enclosingName(n));
      ts.forEachChild(n, visit);
    };
    visit(probe);
    expect(seen).toEqual(['useA', 'useB', 'useC']);
  });
});
