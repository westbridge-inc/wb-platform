import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The mobile Vitest harness is pure Node and has no RN renderer. Keep a
// source-level contract, matching vendorPreviewReadonly.test.ts, around the
// first-open guarantees that are otherwise easy to regress during a UI pass.
const src = readFileSync(join(process.cwd(), 'src/screens/auth/RolePickerScreen.tsx'), 'utf8');

describe('RolePickerScreen first-open contract', () => {
  it('keeps every action reachable with adaptive scrolling and bottom-safe padding', () => {
    expect(src).toMatch(/import \{ Pressable, ScrollView, View \} from 'react-native'/);
    expect(src).toMatch(/const insets = useSafeAreaInsets\(\)/);
    expect(src).toMatch(/<ScrollView[\s\S]*?contentContainerStyle=\{\{[\s\S]*?flexGrow: 1/);
    expect(src).toMatch(/paddingBottom: space\['2xl'\] \+ insets\.bottom/);
    // [UXR-W-015] This used to also require an inner `<View style={{ flexGrow: 1 }}>`
    // wrapper, whose job was to push the funnel links to the bottom of tall
    // screens. That gap WAS the defect the founder's "we can do better" pass
    // caught: three unlabelled links floating in ~300px of nothing read as
    // debug shortcuts. They now follow the content in a titled card, so the
    // wrapper is gone on purpose. The reachability guarantee it stood for is
    // the ScrollView's own flexGrow plus the bottom-safe padding — both still
    // asserted above, and neither depends on the inner wrapper.
    expect(src).not.toContain("<View style={{ flexGrow: 1, justifyContent: 'center' }}>");
  });

  it('opens on PAPER chrome — no maroon slab, one ink display line, one brand moment', () => {
    // SUPERSEDES the old "opens on the brand masthead" contract. That contract
    // pinned a full-bleed maroon gradient slab with a reversed mark and white
    // copy on top of it. The rendered design has no such slab anywhere in the
    // customer app: the top of a screen is the same warm paper as the rest of
    // it, and Home already stopped reaching for GradientMasthead. Keeping the
    // old assertion would have frozen this screen on the retired chrome.
    //
    // What the screen must NOT go back to.
    expect(src).not.toMatch(/<GradientMasthead/);
    expect(src).not.toMatch(/tone="onBrand"/); // nothing reverses out of a slab
    expect(src).not.toMatch(/<Card[\s>]/); // no card chassis around the choices

    // What replaces it, and what still may not regress to a plain white page:
    // the mark in its OWN colours, an ink display-face line, a muted sub-line.
    expect(src).toMatch(/<SwiftMark/);
    expect(src).not.toMatch(/<SwiftMark[^>]*tint=/); // brand mark, not reversed
    expect(src).toMatch(/<T variant="display"/);
    expect(src).toMatch(/<T variant="body" tone="muted"/);

    // Rows on open paper, separated by hairlines — not a stack of cards.
    expect(src).toMatch(/borderTopColor: color\.border\.subtle/);

    // MAROON IS RESERVED: exactly ONE brand fill on the whole screen, the
    // flagship tile. Not the sign-in link, not the funnel glyphs, and not one
    // identity tint per option (the old VERTICAL_TINT[o.tint] read) — three
    // coloured doors is the "every option is a brand moment" failure.
    expect(src.match(/color\.brand\[/g) ?? []).toHaveLength(1);
    expect(src).not.toMatch(/VERTICAL_TINT\[/);
  });

  it('exposes button semantics for the doors, sign-in, and all lower actions', () => {
    const quietRow = src.slice(src.indexOf('function QuietRow'), src.indexOf('export function RolePickerScreen'));
    const roleCard = src.slice(src.indexOf('<PressableScale'), src.indexOf('</PressableScale>'));

    expect(quietRow).toMatch(/accessibilityRole="button"/);
    expect(quietRow).toMatch(/accessibilityLabel=\{label\}/);
    expect(quietRow).toMatch(/accessibilityHint=\{hint\}/);
    expect(quietRow).toMatch(/minHeight: 44/);
    expect(quietRow).toMatch(/maxWidth: '100%'/);
    expect(quietRow).toMatch(/flexShrink: 1/);
    expect(quietRow).not.toMatch(/hitSlop/);

    expect(roleCard).toMatch(/accessibilityRole="button"/);
    expect(roleCard).toMatch(/accessibilityLabel=\{`\$\{d\.title\}\. \$\{d\.sub\}`\}/);
    expect(roleCard).toMatch(/accessibilityHint=\{d\.hint\}/);
    expect(roleCard).toMatch(/minHeight: 44/);

    expect(src).toMatch(/accessibilityLabel="Already have an account\? Sign in"/);
    expect(src).toMatch(/accessibilityHint="Open phone sign in"/);
    expect(src).toMatch(/minHeight: 44,[\s\S]*?accessibilityLabel="Already have an account\? Sign in"/);
    expect(src).toMatch(/maxWidth: '100%',[\s\S]*?textAlign: 'center'/);
    expect(src.match(/<QuietRow/g) ?? []).toHaveLength(3);
  });

  it('seeds the single Guyana launch market for every entry path', () => {
    const pickStart = src.indexOf('const pick =');
    const pick = src.slice(pickStart, src.indexOf('  return (', pickStart));
    expect(pick).toContain('setCountry(DEFAULT_COUNTRY)');
    expect(pick).not.toContain("intent === 'customer'");
    expect(src).toContain("onPress={() => {\n                setCountry(DEFAULT_COUNTRY);\n                setIntent('advertiser');");
  });

  it('makes clear that Deliver and Drive start partner sign-up rather than booking a delivery or a taxi', () => {
    // [APP-INTRO] The old single "Become a Swift Driver" door is now the website's two doors. Both sit under
    // "EARN WITH SWIFT", both say what the partner keeps, and both are announced as a sign-up.
    expect(src).toContain('EARN WITH SWIFT');
    expect(src).toContain("title: 'Deliver with Swift'");
    expect(src).toContain("hint: 'Start delivery rider sign-up'");
    expect(src).toContain("title: 'Drive with Swift'");
    expect(src).toContain("sub: 'Drive a taxi with Swift. Every fare and every tip is yours.'");
    expect(src).toContain("hint: 'Start taxi driver sign-up'");
    expect(src.indexOf('EARN WITH SWIFT')).toBeLessThan(src.indexOf('{PARTNER_DOORS.map('));
  });
});

describe('[APP-INTRO] the welcome opens the website\'s four doors', () => {
  // swiftgy.com's front page is the source of the words: a door renamed on one and not the other is caught here.
  const web = readFileSync(join(process.cwd(), '../web/src/app/(welcome)/page.tsx'), 'utf8');
  const webDoors = [...web.matchAll(/\{ href: '[^']+', title: '([^']+)', body: '([^']+)'/g)].map((m) => ({ title: m[1], body: m[2] }));
  const appDoors = [...src.matchAll(/^\s+title: '([^']+)',\n\s+sub: '([^']+)',/gm)].map((m) => ({ title: m[1], body: m[2] }));

  it('reads four doors on both sides (a parse that found nothing would pass forever)', () => {
    expect(webDoors).toHaveLength(4);
    expect(appDoors).toHaveLength(4);
  });

  it('uses the website\'s titles and lines, in the website\'s order', () => {
    expect(appDoors).toEqual(webDoors);
    expect(webDoors.map((d) => d.title)).toEqual(['Order with Swift', 'Sell on Swift', 'Deliver with Swift', 'Drive with Swift']);
  });

  it('sends each door down a role choice the app already had (no new sign-up path)', () => {
    const door = (key: string) => {
      const at = src.indexOf(`key: '${key}',`);
      return src.slice(at, src.indexOf('},', at));
    };
    expect(door('customer')).toMatch(/intent: 'customer',\s+moverPreset: null,/);
    expect(door('vendor')).toMatch(/intent: 'vendor',\s+moverPreset: null,/);
    expect(door('delivery')).toMatch(/intent: 'mover',\s+moverPreset: 'delivery',/);
    expect(door('taxi')).toMatch(/intent: 'mover',\s+moverPreset: 'taxi',/);
    // The pick is the old one: preset, market, intent. Nothing else is written, and nothing is fetched.
    const pickStart = src.indexOf('const pick =');
    const pick = src.slice(pickStart, src.indexOf('};', pickStart));
    expect(pick).toContain('setMoverPreset(door.moverPreset)');
    expect(pick).toContain('setIntent(door.intent)');
    expect(pick).not.toMatch(/api\.|fetch\(|await /);
  });

  it('keeps ONE flagship: only "Order with Swift" wears the brand tile', () => {
    expect(src).toMatch(/\{door\(ORDER, true\)\}/);
    expect(src).toMatch(/\{door\(d, false\)\}/);
    expect(src.match(/door\([A-Za-z]+, true\)/g) ?? []).toHaveLength(1);
  });
});
