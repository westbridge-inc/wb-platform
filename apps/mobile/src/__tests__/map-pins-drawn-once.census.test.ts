import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [APP-SPEED C · report item 8] Every map pin drawn from its own view is drawn once. With tracksViewChanges on (the
// default), the Android map re-renders each such pin's view into a picture on every frame for as long as the map is
// up. A pin with a child view must say tracksViewChanges={false} (plain views) or be a QuietMarker (an SVG pin: on
// while it first draws, then off). A default pin (self-closing, no child view) has no view to track.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === '__tests__' ? [] : files(path);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

/** Each `<Marker …>` opening tag (props may hold `=>` and nested braces), and whether it closes itself. */
function markerTags(src: string): Array<{ tag: string; selfClosing: boolean; line: number }> {
  const out: Array<{ tag: string; selfClosing: boolean; line: number }> = [];
  const re = /<(Marker|DrivingMarker)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    const tag = src.slice(m.index, i + 1);
    out.push({ tag, selfClosing: tag.endsWith('/>'), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

describe('[APP-SPEED C] map pins with their own view are drawn once', () => {
  const all = files(SRC).flatMap((file) => markerTags(readFileSync(file, 'utf8')).map((t) => ({ ...t, file: file.slice(SRC.length + 1) })));

  it('finds the pins (the census is looking at the maps)', () => {
    expect(all.length).toBeGreaterThanOrEqual(10);
    for (const screen of ['DeliveryScreen.tsx', 'TaxiScreen.tsx', 'CourierScreen.tsx', 'MoverHomeScreen.tsx']) {
      expect(all.some((t) => t.file.endsWith(screen)), screen).toBe(true);
    }
  });

  it('every <Marker> with a child view says tracksViewChanges={false}', () => {
    const loud = all.filter((t) => !t.selfClosing && !t.tag.includes('tracksViewChanges={false}'));
    expect(loud.map((t) => `${t.file}:${t.line}`)).toEqual([]);
  });

  it('the SVG pins (drop-off pin, the car) are QuietMarkers', () => {
    const read = (f: string) => readFileSync(join(SRC, f), 'utf8');
    expect(read('modules/movement/screens/TaxiScreen.tsx').match(/<QuietMarker\b/g)?.length ?? 0).toBe(4);
    expect(read('modules/movement/screens/CourierScreen.tsx')).toMatch(/<QuietMarker coordinate=\{dropoffLL\} title="To">/);
  });
});
