/** @jsxImportSource react */
import Svg, { G, Path } from 'react-native-svg';
import { color } from '@swift/ui';

/**
 * The Swift mark — a swift in flight. Vector, so it scales crisp at any size and
 * recolours for light/dark surfaces. Default is the two-tone red brand mark; pass
 * `tint`/`accent` (e.g. white) for a reversed mark on a red surface.
 */
export function SwiftMark({
  size = 40,
  tint,
  accent,
}: {
  size?: number;
  tint?: string;
  accent?: string;
}) {
  const primary = tint ?? color.brand[500];
  const secondary = accent ?? color.brand[600];
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <G transform="translate(-1.5,-6)">
        <Path
          d="M97 20 C76 30 60 40 50 52 C44 44 30 36 6 36 C26 42 38 52 44 64 C40 74 34 82 28 92 C42 80 50 70 54 60 C62 56 76 46 97 20 Z"
          fill={primary}
        />
        <Path d="M50 52 C62 56 76 46 97 20 C76 30 60 40 50 52 Z" fill={secondary} />
      </G>
    </Svg>
  );
}

/**
 * The Swift wordmark: "swift" exactly as drawn in the brand logo (assets/brand/swift_logo_horizontal.svg), as a
 * vector, so it is the brand's own lettering at any size rather than a font's approximation of it. Ink by default;
 * pass `tint` (white) on the maroon ground. `height` is the full box, ascender to descender.
 */
const WORDMARK_PATH =
  'M309 -14Q228 -14 166.0 15.0Q104 44 69.0 98.0Q34 152 34 228V256H164V228Q164 165 203.0 133.5Q242 102 309 102Q377 102 410.5 129.0Q444 156 444 198Q444 227 427.5 245.0Q411 263 379.5 274.5Q348 286 303 296L280 301Q208 317 156.5 341.5Q105 366 77.5 406.0Q50 446 50 510Q50 574 80.5 619.5Q111 665 166.5 689.5Q222 714 297 714Q372 714 430.5 688.5Q489 663 522.5 612.5Q556 562 556 486V456H426V486Q426 526 410.5 550.5Q395 575 366.0 586.5Q337 598 297 598Q237 598 208.5 575.5Q180 553 180 514Q180 488 193.5 470.0Q207 452 234.0 440.0Q261 428 303 419L326 414Q401 398 456.5 373.0Q512 348 543.0 307.0Q574 266 574 202Q574 138 541.5 89.5Q509 41 449.5 13.5Q390 -14 309 -14Z M726 0 656 496H781L825 85H843L907 496H1109L1173 85H1191L1235 496H1360L1290 0H1081L1017 411H999L935 0Z M1480 0V496H1606V0ZM1543 554Q1509 554 1485.5 576.0Q1462 598 1462 634Q1462 670 1485.5 692.0Q1509 714 1543 714Q1578 714 1601.0 692.0Q1624 670 1624 634Q1624 598 1601.0 576.0Q1578 554 1543 554Z M1838 0V392H1712V496H1838V588Q1838 639 1868.5 669.5Q1899 700 1948 700H2078V596H1992Q1964 596 1964 566V496H2094V392H1964V0Z M2392 0Q2343 0 2312.5 30.5Q2282 61 2282 112V392H2158V496H2282V650H2408V496H2544V392H2408V134Q2408 104 2436 104H2532V0Z';
/** The wordmark's box in font units: x 34..2544, y -14..714. */
const WORDMARK_BOX = { width: 2510, height: 728 } as const;
export const WORDMARK_ASPECT = WORDMARK_BOX.width / WORDMARK_BOX.height;

export function SwiftWordmark({ height = 32, tint }: { height?: number; tint?: string }) {
  return (
    <Svg width={height * WORDMARK_ASPECT} height={height} viewBox={`0 0 ${WORDMARK_BOX.width} ${WORDMARK_BOX.height}`}>
      {/* Font units grow upwards; flip them and move the box's corner to the origin. */}
      <G transform="translate(-34,714) scale(1,-1)">
        <Path d={WORDMARK_PATH} fill={tint ?? color.text.primary} />
      </G>
    </Svg>
  );
}
