import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'ios' }, Pressable: 'Pressable',
  ScrollView: 'ScrollView', TextInput: 'TextInput', View: 'View',
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('@react-navigation/native', () => ({ useNavigation: () => ({}), useRoute: () => ({ params: {} }) }));
vi.mock('@swift/ui', () => ({ color: {}, font: {}, fontSize: {}, radius: {}, space: { sm: 4, '2xl': 24 } }));
vi.mock('../../../hooks/customer', () => ({ useItemFeedback: vi.fn(), useOrder: vi.fn(), useRateOrder: vi.fn(), useRatingTags: vi.fn() }));
vi.mock('../../../lib/images', () => ({ DARK_BLURHASH: '', vendorPhoto: () => null }));
vi.mock('../../../kit', () => Object.fromEntries(
  ['Chip', 'ErrorState', 'Header', 'IconChip', 'LoadingBlock', 'PillButton', 'PopupCard', 'PopupTitle', 'Screen', 'Stars', 'T'].map((n) => [n, n]),
));
vi.mock('../../../kit/after-dismiss', () => ({ afterDismiss: (fn: () => void) => fn() }));

import { TagChips } from './FeedbackScreen';

// [STORE-WORDS · owner 9 Nov 2026] Rating a clothing shop offered "Tasty food" and "Arrived cold".

function nodes(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) nodes(child, out); return out; }
  out.push(node);
  nodes(node.props?.children, out);
  return out;
}
const SETS = {
  positive: [{ slug: 'tasty-food', label: 'Tasty food' }, { slug: 'great-value', label: 'Great value' }],
  negative: [{ slug: 'missing-items', label: 'Missing items' }, { slug: 'cold-food', label: 'Arrived cold' }],
};
const chips = (score: number, vendorType?: string) =>
  nodes(TagChips({ score, sets: SETS, selected: [], onToggle: () => {}, vendorType })).filter((n) => n.type === 'Chip').map((n) => n.props.label);

describe('[STORE-WORDS] rating tags follow the store kind', () => {
  it('a shop is never offered the food-only tags', () => {
    expect(chips(5, 'STORE')).toEqual(['Great value']);
    expect(chips(2, 'STORE')).toEqual(['Missing items']);
    expect(chips(5, 'SERVICE')).toEqual(['Great value']);
  });

  it('a restaurant, and an order from an older server that names no kind, keep every tag', () => {
    expect(chips(5, 'RESTAURANT')).toEqual(['Tasty food', 'Great value']);
    expect(chips(2, 'RESTAURANT')).toEqual(['Missing items', 'Arrived cold']);
    expect(chips(2)).toEqual(['Missing items', 'Arrived cold']);
  });
});
