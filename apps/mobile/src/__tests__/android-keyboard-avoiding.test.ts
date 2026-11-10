import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// [ANDROID 9 Nov] A shopper on Android could not reach the email field on
// "Create your new account": with the keyboard open the form would not scroll.
//
// Expo SDK 56 / RN 0.85 draw every Android window EDGE-TO-EDGE (mandatory;
// Expo's prebuild warns that `edgeToEdgeEnabled` can no longer be turned off),
// and an edge-to-edge window is never resized for the keyboard — the old
// `adjustResize` (app.config softwareKeyboardLayoutMode, default 'resize') is
// inert. RN core does not apply the IME inset to the root, and
// react-native-safe-area-context's bottom inset excludes the keyboard. So the
// classic idiom
//
//     <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
//
// — "Android resizes by itself" — leaves the screen full height on Android:
// RN's KeyboardAvoidingView with no behavior renders a plain View that never
// moves, the keyboard covers the bottom of the form, and a form that fits the
// screen has nothing to scroll. Every KeyboardAvoidingView in the app must
// actually avoid the keyboard on Android, and the screen forms go through the
// kit KeyboardAvoider (src/kit/keyboard-avoider.tsx), which also starts from a
// keyboard that is already open when the screen mounts (Android sends no new
// keyboardDidShow when focus moves between fields, e.g. OTP code -> sign-up).
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');
const AVOIDING = new Set(['padding', 'height', 'position']);
/** The forms whose bottom fields the keyboard hid on Android (sign-up first). */
const FORMS = [
  'screens/auth/RegisterScreen.tsx',
  'screens/auth/PhoneEntryScreen.tsx',
  'modules/chat/screens/ConversationScreen.tsx',
  'modules/profile/screens/AddAddressScreen.tsx',
  'modules/profile/screens/PersonalDataScreen.tsx',
  'modules/orders/screens/FeedbackScreen.tsx',
];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== '__tests__') sources(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** Each <KeyboardAvoidingView ...> opening tag in a file, with its behavior attribute (source text). */
function keyboardViews(src: string): Array<{ line: number; behavior: string | null }> {
  const found: Array<{ line: number; behavior: string | null }> = [];
  const open = /<KeyboardAvoidingView\b/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src))) {
    // The opening tag ends before the first child element starts.
    const next = src.indexOf('<', m.index + 1);
    const tag = src.slice(m.index, next === -1 ? undefined : next);
    const literal = /behavior="([^"]*)"/.exec(tag);
    const expr = /behavior=\{([^}]*)\}/.exec(tag);
    found.push({ line: src.slice(0, m.index).split('\n').length, behavior: literal ? `'${literal[1]}'` : expr ? expr[1]!.trim() : null });
  }
  return found;
}

const UNREADABLE = 'UNREADABLE (teach this guard the new form)';

/** One value: a quoted string literal or `undefined`. */
function value(text: string): unknown {
  const t = text.trim();
  if (t === 'undefined') return undefined;
  const q = /^(['"])(\w+)\1$/.exec(t);
  return q ? q[2] : UNREADABLE;
}

/**
 * What a behavior attribute is on a given platform. Reads the two forms the app
 * uses — a literal, or `Platform.OS === '<os>' ? A : B` — without evaluating code.
 */
function behaviorOn(os: 'android' | 'ios', expr: string | null): unknown {
  if (expr == null) return undefined;
  const ternary = /^Platform\.OS\s*===\s*(['"])(\w+)\1\s*\?\s*([^:]+?)\s*:\s*(.+)$/.exec(expr);
  if (ternary) return value(os === ternary[2] ? ternary[3]! : ternary[4]!);
  return value(expr);
}

const files = sources(SRC);
const views = files.flatMap((file) => {
  const src = readFileSync(file, 'utf8');
  return keyboardViews(src).map((v) => ({ ...v, where: `${relative(SRC, file)}:${v.line}` }));
});

describe('[ANDROID 9 Nov] every KeyboardAvoidingView avoids the keyboard on Android too', () => {
  it('finds the app\'s keyboard-avoiding views (the scan is looking at real code)', () => {
    const where = views.map((v) => v.where.split(':')[0]);
    expect(where).toContain('kit/keyboard-avoider.tsx');
    expect(where).toContain('kit/card.tsx');
  });

  it('screens never use React Native\'s KeyboardAvoidingView directly: only the kit does', () => {
    const direct = views.filter((v) => !v.where.startsWith('kit/')).map((v) => v.where);
    expect(direct, 'use the kit KeyboardAvoider (it also lifts for a keyboard already open on Android)').toEqual([]);
  });

  for (const screen of FORMS) {
    it(`${screen} lifts its form with the kit KeyboardAvoider`, () => {
      const src = readFileSync(join(SRC, screen), 'utf8');
      expect(src).toMatch(/import \{ KeyboardAvoider \} from '(\.\.\/)+kit\/keyboard-avoider';/);
      expect(src).toMatch(/<KeyboardAvoider style=\{\{ flex: 1 \}\}>/);
      expect(src).toContain('</KeyboardAvoider>');
    });
  }

  for (const v of views) {
    it(`${v.where} moves out of the keyboard's way on Android and on iOS`, () => {
      expect(v.behavior, `${v.where} has no behavior: on Android that is a View that never moves`).not.toBeNull();
      expect(AVOIDING.has(behaviorOn('android', v.behavior) as string), `${v.where} behavior on Android = ${String(behaviorOn('android', v.behavior))}`).toBe(true);
      expect(AVOIDING.has(behaviorOn('ios', v.behavior) as string), `${v.where} behavior on iOS = ${String(behaviorOn('ios', v.behavior))}`).toBe(true);
    });
  }

  it('the kit KeyboardAvoider is "padding" on iOS (RN\'s own view) and lifts itself on Android', () => {
    const kit = views.filter((v) => v.where.startsWith('kit/keyboard-avoider.tsx'));
    expect(kit).toHaveLength(1);
    expect(behaviorOn('ios', kit[0]!.behavior)).toBe('padding');
    const src = readFileSync(join(SRC, 'kit/keyboard-avoider.tsx'), 'utf8');
    expect(src).toMatch(/Platform\.OS === 'ios' \? <KeyboardAvoidingView behavior="padding" \{\.\.\.props\} \/> : <AndroidKeyboardAvoider \{\.\.\.props\} \/>/);
  });
});
