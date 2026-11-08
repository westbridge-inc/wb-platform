/** @jsxImportSource react */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, space } from '@swift/ui';

// ---------------------------------------------------------------------------
// [APP-SPEED D · owner 7 Nov: "you tap the Services tab or Taxi or Groceries —
// it LOADS, then goes to it"] A door from Home opens on the SHAPE of what it
// will show, drawn on the first frame: rows for a list, cards for a grid, pills
// for a set of choices. A centred spinner on a blank page read as the app still
// loading the screen itself.
//
// Quiet ground blocks (the category rail's skeleton, modules/shop/CategoryRail),
// no animation, no text, nothing to press: a skeleton never says "nothing here"
// and never offers an action. A screen keeps its failure branch (a failed read
// is an error, never an empty list; the failed-read-never-empty census) and
// shows these only while its first read is on its way.
//
// Plain Views and tokens only, so every screen test that stands the kit in can
// still draw the real thing.
// ---------------------------------------------------------------------------

const GUTTER = space['2xl'];
const block = (style: ViewStyle): ViewStyle => ({ backgroundColor: color.surface.sunken, ...style });

/** The wrapper every skeleton shares: one "Loading" for a screen reader, not a row of empty boxes. */
function Shape({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  return (
    <View
      testID="door-skeleton"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      style={[{ flex: 1 }, style]}
    >
      {children}
    </View>
  );
}

/** A list of rows (stores, orders, notifications): a square thumb and two lines each. */
export function ListSkeleton({ rows = 6, thumb = 56, style }: { rows?: number; thumb?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <Shape style={[{ paddingHorizontal: GUTTER, paddingTop: space.lg, gap: space.lg }, style]}>
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={block({ width: thumb, height: thumb, borderRadius: radius.md })} />
          <View style={{ flex: 1, gap: space.sm }}>
            <View style={block({ width: i % 2 ? '55%' : '70%', height: 14, borderRadius: radius.full })} />
            <View style={block({ width: i % 2 ? '35%' : '45%', height: 10, borderRadius: radius.full })} />
          </View>
        </View>
      ))}
    </Shape>
  );
}

/** A two-column grid of cards (favourites, recommended, the Market): a picture and two lines each. */
export function GridSkeleton({ cards = 4, style }: { cards?: number; style?: StyleProp<ViewStyle> }) {
  const rows = Math.ceil(cards / 2);
  return (
    <Shape style={[{ paddingHorizontal: GUTTER, paddingTop: space.md, gap: space.lg }, style]}>
      {Array.from({ length: rows }, (_, r) => (
        <View key={r} style={{ flexDirection: 'row', gap: space.lg }}>
          {[0, 1].map((c) => (
            <View key={c} style={{ flex: 1, gap: space.sm }}>
              <View style={block({ height: 120, borderRadius: radius.lg })} />
              <View style={block({ width: '75%', height: 12, borderRadius: radius.full })} />
              <View style={block({ width: '45%', height: 10, borderRadius: radius.full })} />
            </View>
          ))}
        </View>
      ))}
    </Shape>
  );
}

/** A set of choices: pills (the services catalogue) or square tiles with a caption (categories). */
export function ChipsSkeleton({ count = 8, shape = 'pill', style }: { count?: number; shape?: 'pill' | 'tile'; style?: StyleProp<ViewStyle> }) {
  return (
    <Shape style={[{ flexGrow: 0, flexDirection: 'row', flexWrap: 'wrap', gap: shape === 'tile' ? 12 : space.sm }, style]}>
      {Array.from({ length: count }, (_, i) =>
        shape === 'tile' ? (
          <View key={i} style={{ width: 76, alignItems: 'center' }}>
            <View style={block({ width: 64, height: 64, borderRadius: radius.xl })} />
            <View style={block({ width: 48, height: 10, borderRadius: radius.full, marginTop: space.xs })} />
          </View>
        ) : (
          <View key={i} style={block({ width: 72 + ((i * 23) % 48), height: 36, borderRadius: radius.full })} />
        ),
      )}
    </Shape>
  );
}
