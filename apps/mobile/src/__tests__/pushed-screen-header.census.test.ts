import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// ---------------------------------------------------------------------------
// [UI-HEADERS, owner 7 Nov 2026, with screenshots] "Your activity" drew a round
// Back on its own, then an "ORDERS & RIDES" eyebrow and a big "Your activity"
// title BELOW it. Favourites draws `<Header title="Favourites" />`: the round
// Back and a centred title in ONE row. Every pushed inner screen must look like
// Favourites.
//
// 1. The converted screens draw the kit Header WITH its title, and no Back of
//    their own (a Pressable drawing a back chevron or arrow).
// 2. No screen puts a title-less kit Header (or a back chip) directly above an
//    eyebrow + big title block: the title belongs in the Header row.
// 3. The words people read say "Favourites" (the app's spelling); route names
//    and identifiers ("Favorites", useFavorites) stay as they are.
// Tab ROOT screens (Home, Cart, Profile, Market, the partner home tabs) have no
// Back and keep their own headers.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const parse = (file: string, text: string) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
    return e.name.endsWith('.tsx') && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

const tagName = (el: ts.JsxOpeningLikeElement) => el.tagName.getText();
const attr = (el: ts.JsxOpeningLikeElement, name: string) =>
  el.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
function stringAttr(el: ts.JsxOpeningLikeElement, name: string): string | undefined {
  const init = attr(el, name)?.initializer;
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) return init.expression.text;
  return undefined;
}
function openings(sf: ts.SourceFile): ts.JsxOpeningLikeElement[] {
  const out: ts.JsxOpeningLikeElement[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const BACK_ICONS = new Set(['chevron-left', 'arrow-left']);
const PRESSABLES = new Set(['Pressable', 'PressableScale', 'TouchableOpacity']);
/** Pressables in this file that draw a back glyph themselves (not the kit Header's chip). */
function ownBackControls(sf: ts.SourceFile): number {
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && PRESSABLES.has(tagName(node.openingElement))) {
      let draws = false;
      const find = (c: ts.Node) => {
        if (ts.isJsxSelfClosingElement(c) && tagName(c) === 'Feather' && BACK_ICONS.has(stringAttr(c, 'name') ?? '')) draws = true;
        ts.forEachChild(c, find);
      };
      node.children.forEach(find);
      if (draws) n += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}
/** Every kit <Header …> in the file, with its title source text (undefined when it has none). */
function headers(sf: ts.SourceFile): Array<{ title: string | undefined }> {
  return openings(sf)
    .filter((el) => tagName(el) === 'Header')
    .map((el) => {
      const init = attr(el, 'title')?.initializer;
      return { title: init ? (ts.isStringLiteral(init) ? init.text : init.getText()) : undefined };
    });
}

// The screens converted by this change, with the title each now draws in its Header row.
const CONVERTED: Array<[file: string, title: string]> = [
  ['modules/orders/screens/OrdersHistoryScreen.tsx', 'Your activity'],
  ['modules/vendor/screens/VendorCategoryReviewScreen.tsx', 'Review your categories'],
  ['modules/vendor/screens/VendorBulkImportScreen.tsx', 'Bulk import'],
  ['modules/advertiser/screens/CampaignDetailScreen.tsx', '{campaign.name}'],
  ['modules/advertiser/screens/NewCampaignScreen.tsx', 'New campaign'],
  ['modules/shop/screens/FavoritesScreen.tsx', 'Favourites'],
];

describe('[UI-HEADERS] every pushed inner screen uses the Favourites header', () => {
  it.each(CONVERTED)('%s draws the kit Header with its title in the Back row, and no Back of its own', (file, title) => {
    const sf = parse(file, read(file));
    expect(headers(sf).map((h) => h.title), 'the title is the kit Header’s').toContain(title);
    expect(ownBackControls(sf), 'no hand-drawn Back beside the kit Header’s').toBe(0);
  });

  it('Your activity has no separate eyebrow + big title below Back', () => {
    const text = read('modules/orders/screens/OrdersHistoryScreen.tsx');
    expect(text).not.toContain('>ORDERS & RIDES<');
    expect(text).not.toMatch(/<T variant="title"[^>]*>Your activity<\/T>/);
  });

  // A title-less Header (or a back chip), then an eyebrow + big title under it, in the same parent.
  function stackedTitles(file: string, text: string): string[] {
    const sf = parse(file, text);
    const hits: string[] = [];
    const isBack = (c: ts.JsxChild) => {
      const el = ts.isJsxSelfClosingElement(c) ? c : ts.isJsxElement(c) ? c.openingElement : undefined;
      if (!el) return false;
      if (tagName(el) === 'Header') return !attr(el, 'title');
      return tagName(el) === 'CircleChip' && BACK_ICONS.has(stringAttr(el, 'icon') ?? '');
    };
    const variants = (n: ts.Node): string[] => {
      const out: string[] = [];
      const visit = (c: ts.Node) => {
        if ((ts.isJsxSelfClosingElement(c) || ts.isJsxOpeningElement(c)) && tagName(c) === 'T') out.push(stringAttr(c, 'variant') ?? '');
        ts.forEachChild(c, visit);
      };
      visit(n);
      return out;
    };
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
        // Whitespace and {/* comments */} are not siblings.
        const kids = n.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces) && !(ts.isJsxExpression(c) && !c.expression));
        kids.forEach((c, i) => {
          const next = kids[i + 1];
          if (!isBack(c) || !next) return;
          const v = variants(next);
          if (v.length >= 2 && v[0] === 'micro' && (v[1] === 'title' || v[1] === 'display')) {
            hits.push(`${file}:${sf.getLineAndCharacterOfPosition(c.getStart()).line + 1}`);
          }
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return hits;
  }

  it('no screen stacks an eyebrow + big title under a title-less Back row', () => {
    const files = sources(SRC).map((f) => ({ file: f.slice(SRC.length + 1), text: readFileSync(f, 'utf8') }));
    expect(files.flatMap(({ file, text }) => stackedTitles(file, text))).toEqual([]);
  });

  it('the stacked-title census catches the old shape and passes the Favourites one (guards the guard)', () => {
    const wrap = (jsx: string) => `export function S() { return (${jsx}); }`;
    const old = `<Screen><Header /><View style={{ paddingTop: 8 }}><T variant="micro" tone="muted">ORDERS & RIDES</T><T variant="title">Your activity</T></View></Screen>`;
    const chip = `<View><CircleChip icon="chevron-left" label="Back" /><View><T variant="micro">EYEBROW</T><T variant="title">Big</T></View></View>`;
    const now = `<Screen><Header title="Your activity" /><FlatList /></Screen>`;
    expect(stackedTitles('virtual.tsx', wrap(old))).toHaveLength(1);
    expect(stackedTitles('virtual.tsx', wrap(chip))).toHaveLength(1);
    expect(stackedTitles('virtual.tsx', wrap(now))).toEqual([]);
  });
});

describe('[UI-HEADERS] the words say "Favourites"', () => {
  const READ_ATTRS = new Set(['title', 'label', 'body', 'actionLabel', 'accessibilityLabel', 'accessibilityHint', 'message', 'placeholder']);
  function americanSpellings(file: string, text: string): string[] {
    const sf = parse(file, text);
    const hits: string[] = [];
    const flag = (n: ts.Node, words: string) => {
      if (/\bfavorites?\b/i.test(words)) hits.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} "${words.trim()}"`);
    };
    const visit = (n: ts.Node) => {
      if (ts.isJsxText(n)) flag(n, n.text);
      if (ts.isJsxAttribute(n) && READ_ATTRS.has(n.name.getText()) && n.initializer) {
        const init = n.initializer;
        const lit = ts.isStringLiteral(init) ? init : ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression) ? init.expression : undefined;
        if (lit) flag(lit, lit.text);
      }
      if (ts.isPropertyAssignment(n) && READ_ATTRS.has(n.name.getText()) && ts.isStringLiteralLike(n.initializer)) flag(n.initializer, n.initializer.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return hits;
  }

  it('no title, label or sentence on screen spells it "Favorites"', () => {
    const files = sources(SRC).map((f) => ({ file: f.slice(SRC.length + 1), text: readFileSync(f, 'utf8') }));
    expect(files.flatMap(({ file, text }) => americanSpellings(file, text))).toEqual([]);
  });

  it('the spelling census reads titles, labels and words, and leaves route names alone (guards the guard)', () => {
    const wrap = (jsx: string) => `export function S() { return (${jsx}); }`;
    expect(americanSpellings('v.tsx', wrap(`<Header title="Favorites" />`))).toHaveLength(1);
    expect(americanSpellings('v.tsx', wrap(`<EmptyState title="Sign in to save favorites" />`))).toHaveLength(1);
    expect(americanSpellings('v.tsx', wrap(`<T>Your favorites</T>`))).toHaveLength(1);
    expect(americanSpellings('v.ts', `const row = { label: 'Favorites', go: 'Favorites' };`)).toHaveLength(1);
    expect(americanSpellings('v.tsx', wrap(`<Stack.Screen name="Favorites" component={FavoritesScreen} />`))).toEqual([]);
    expect(americanSpellings('v.ts', `navigation.navigate('Favorites'); const row = { label: 'Favourites', go: 'Favorites' };`)).toEqual([]);
  });
});
