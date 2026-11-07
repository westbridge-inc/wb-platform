/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { Marker } from 'react-native-maps';

/** How long a pin's own view has to draw (an SVG paints a frame or two late) before the map keeps its picture. */
export const MARKER_SETTLE_MS = 600;

/**
 * [APP-SPEED C · report item 8] `tracksViewChanges` for a map pin drawn from its own view. With it on (the default),
 * the Android map re-renders the pin's view into a picture on every frame, for every pin, for as long as the map is
 * shown. A pin of plain views passes `false` directly. A pin drawn with SVG (the drop-off pin, the car) keeps it on
 * just long enough to draw, then off; a new `look` (the car fading when its fix goes stale, another body or colour)
 * draws it again the same way.
 */
export function useMarkerTracking(look: string): boolean {
  const [tracking, setTracking] = useState(true);
  useEffect(() => {
    setTracking(true);
    const timer = setTimeout(() => setTracking(false), MARKER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [look]);
  return tracking;
}

type MarkerProps = React.ComponentProps<typeof Marker>;
/** A Marker (or the animated driving marker, `as`) whose view is drawn once per `look` (useMarkerTracking). */
export function QuietMarker({ look = '', as: Pin = Marker, ...props }: Omit<MarkerProps, 'tracksViewChanges'> & {
  look?: string;
  /** The animated driving marker takes its animated coordinate here. */
  as?: React.ComponentType<any>;
  animatedProps?: unknown;
}) {
  const tracking = useMarkerTracking(look);
  return <Pin {...props} tracksViewChanges={tracking} />;
}
