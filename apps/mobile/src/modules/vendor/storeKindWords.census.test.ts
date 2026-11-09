import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [STORE-WORDS sweep · owner 9 Nov 2026] A clothing shop read kitchen words on screens it sees every day:
// "Checking your menu", "Menu & inventory", "Copy a menu", "Back to menu", "your live web menu",
// "Add your menu". Each screen below now takes the store's own word for its items from CATALOGUE_META
// (modules/vendor/shared.tsx: Menu / Inventory / Products / Services) or, for its orders, from
// lib/storeKindWords. This census reads every text literal on those screens: a kitchen word may stay
// only where the screen has already asked whether the store is a restaurant (the list below, each one
// the exact words a restaurant read before). A new hard-coded "menu" fails here.
// ---------------------------------------------------------------------------

vi.mock('react-native', () => ({ Pressable: () => null, View: () => null }));
vi.mock('@expo/vector-icons', () => ({ Feather: () => null, MaterialCommunityIcons: () => null }));
vi.mock('@swift/ui', () => {
  const token: any = new Proxy({}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : token) });
  return { color: token, font: token, fontSize: token, radius: token, space: token };
});
vi.mock('../../kit', () => ({
  T: () => null, TonePill: () => null, PillButton: () => null, useLogoutConfirm: () => () => {},
  DecorativeIcon: () => null, PopupCard: () => null, PopupTitle: () => null,
}));
vi.mock('../../components/onboarding/BackToSwiftButton', () => ({ BackToSwiftButton: () => null }));

const SRC = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

/** Every '…', "…" and `…` literal on a line that is not a comment; a template's text is read around its ${…}. */
function literals(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) continue;
    for (const m of line.matchAll(/`([^`\n]*)`/g)) out.push((m[1] ?? '').replace(/\$\{[^}]*\}/g, '…'));
    for (const m of line.replace(/`[^`\n]*`/g, (tpl) => tpl.replace(/^`|`$/g, ' ').replace(/[^$]\{|\}/g, ' ')).matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)) {
      out.push(m[1] ?? m[2] ?? '');
    }
  }
  return out;
}

const KITCHEN = /\bmenu\b|\bprep\b|kitchen|cooking/i;
/** Not words a person reads: a route name, a file kind, an import path. */
const CODE = /^(menu-pdf|menu|Menu|\.\.?\/.*)$/;

/** Each screen, and the only kitchen words it may still hold (each behind a restaurant check). */
const SCREENS: Record<string, string[]> = {
  'modules/vendor/screens/VendorOps.tsx': ['Menu & inventory'],
  'modules/vendor/screens/VendorMenuScreen.tsx': [],
  'modules/vendor/screens/VendorBulkImportScreen.tsx': ['Pick a file (CSV, Excel, or PDF menu)', ' in your menu'],
  'modules/vendor/screens/VendorBranchesScreen.tsx': ['Copy a menu'],
  // "On your menu or price list" is a placement tip that fits any store (a shop has a price list).
  'modules/vendor/screens/VendorMyQrScreen.tsx': ['Customers scan this to open your live web menu — no app install', 'On your menu or price list', 'Open web menu'],
  'modules/vendor/screens/VendorItemEditorScreen.tsx': [],
  'modules/vendor/screens/VendorOrderDetailScreen.tsx': [],
  'components/onboarding/WentLive.tsx': ['Your business passed review. Add your menu, open the store, and the orders start here.'],
  'components/KitchenCapacityCard.tsx': [],
  'modules/shop/screens/RestaurantScreen.tsx': ['Loading the menu'],
};

describe('[STORE-WORDS sweep] the store\'s screens hold no kitchen word a shop could read', () => {
  for (const [path, allowed] of Object.entries(SCREENS)) {
    it(path, () => {
      const found = literals(read(path)).filter((s) => KITCHEN.test(s) && !CODE.test(s));
      expect([...new Set(found)].sort()).toEqual([...allowed].sort());
    });
  }

  it('the item editor reads the gone words through the store\'s kind', () => {
    expect(read('modules/vendor/screens/VendorItemEditorScreen.tsx')).toMatch(/saveRefusal\(save\.error, store\?\.vendorType\)/);
    expect(read('modules/vendor/screens/VendorItemEditorScreen.tsx')).toMatch(/return itemGoneWords\(vendorType\);/);
  });

  it('the item-gone words follow the store\'s word for its items; a restaurant keeps its sentence', async () => {
    const { itemGoneWords } = await import('../../lib/storeKindWords');
    expect(itemGoneWords('RESTAURANT')).toBe('This section or item was removed on another phone. Go back and open the menu again.');
    expect(itemGoneWords('STORE')).toBe('This section or item was removed on another phone. Go back and open the catalogue again.');
    expect(itemGoneWords('SERVICE')).toBe('This section or item was removed on another phone. Go back and open the services again.');
    expect(itemGoneWords('STORE')).not.toMatch(KITCHEN);
  });
});

/** Every string a React element tree would draw, without a renderer. */
function texts(node: any, out: string[] = []): string[] {
  if (node == null || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; }
  if (typeof node === 'object') {
    if (typeof node.props?.label === 'string') out.push(node.props.label);
    texts(node.props?.children, out);
  }
  return out;
}

describe('[STORE-WORDS sweep] the "you\'re live" popup and the QR screen', () => {
  it('a restaurant (or a store whose kind is not known yet) is told to add its menu, exactly as before', async () => {
    const { WentLivePopup } = await import('../../components/onboarding/WentLive');
    for (const vendorType of ['RESTAURANT', undefined]) {
      const drawn = texts(WentLivePopup({ visible: true, onClose: () => {}, kind: 'vendor', vendorType })).join(' ');
      expect(drawn).toContain('Your business passed review. Add your menu, open the store, and the orders start here.');
    }
  });

  it('a shop, a supermarket or a service business is told to add its items, never a menu', async () => {
    const { WentLivePopup } = await import('../../components/onboarding/WentLive');
    for (const vendorType of ['STORE', 'SUPERMARKET', 'SERVICE']) {
      const drawn = texts(WentLivePopup({ visible: true, onClose: () => {}, kind: 'vendor', vendorType })).join(' ');
      expect(drawn, vendorType).toContain('Your business passed review. Add your items, open the store, and the orders start here.');
      expect(drawn, vendorType).not.toMatch(KITCHEN);
    }
    expect(read('modules/vendor/VendorStack.tsx')).toMatch(/vendorType=\{store\.vendorType\}/);
  });

  it('each allowed kitchen word on the store screens sits behind a restaurant check', () => {
    expect(read('modules/vendor/screens/VendorOps.tsx')).toMatch(/label=\{catalogue === 'Menu' \? 'Menu & inventory' : catalogue\}/);
    expect(read('modules/vendor/screens/VendorBranchesScreen.tsx')).toMatch(/\{catalogueLower === 'menu' \? 'Copy a menu' : `Copy \$\{catalogueLower\}`\}/);
    const bulk = read('modules/vendor/screens/VendorBulkImportScreen.tsx');
    expect(bulk).toMatch(/label=\{isMenu \? 'Pick a file \(CSV, Excel, or PDF menu\)' : 'Pick a file \(CSV, Excel, or PDF price list\)'\}/);
    expect(bulk).toMatch(/\(isMenu \? ' in your menu' : ' in your price list'\)/);
    expect(read('modules/shop/screens/RestaurantScreen.tsx')).toMatch(/preview\.vendorType === 'RESTAURANT' \? 'Loading the menu' : 'Loading the store'/);
  });

  it('the QR screen says "web menu" only behind a restaurant check', () => {
    const qr = read('modules/vendor/screens/VendorMyQrScreen.tsx');
    expect(qr).toMatch(/profile\.store\?\.vendorType === 'RESTAURANT' \|\| !profile\.store\?\.vendorType\s*\? 'Customers scan this to open your live web menu — no app install'\s*: 'Customers scan this to open your store on the web — no app install'/);
    expect(qr).toMatch(/profile\.store\?\.vendorType === 'RESTAURANT' \|\| !profile\.store\?\.vendorType \? 'Open web menu' : 'Open web store'/);
  });
});
