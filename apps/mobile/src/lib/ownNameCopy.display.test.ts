import { describe, expect, it } from 'vitest';
import * as copy from './ownNameCopy';

// [OWNER-ASKS 9 Nov 2026] The signed declaration's words stay exactly as the server versions them; only how they are
// shown changes: the raw first line "I TRADE UNDER MY OWN NAME (v1)" becomes a plain title and a "Version 1" line.

const display = (copy as { ownNameDeclarationDisplay?: (text: string) => { heading: string; title: string; version: string | null; body: string } })
  .ownNameDeclarationDisplay;

describe('[OWNER-ASKS 9 Nov] the declaration as shown', () => {
  it('a plain title and the version, in place of the raw first line', () => {
    expect(display).toBeTypeOf('function');
    const shown = display!(copy.OWN_NAME_DECLARATION_V1);
    expect(shown.title).toBe('Declaration: I trade under my own name');
    expect(shown.version).toBe('Version 1');
    expect(shown.heading).toBe('I TRADE UNDER MY OWN NAME (v1)');
    expect(shown.body.startsWith('I declare that:')).toBe(true);
  });

  it('the first line and the body rejoin to the signed words, byte for byte', () => {
    const shown = display!(copy.OWN_NAME_DECLARATION_V1);
    expect(`${shown.heading}\n\n${shown.body}`).toBe(copy.OWN_NAME_DECLARATION_V1);
    expect(copy.OWN_NAME_DECLARATION_VERSION).toBe('v1');
  });

  it('words without a version line are shown whole, never cut', () => {
    const shown = display!('Just one paragraph.');
    expect(shown.body).toBe('Just one paragraph.');
    expect(shown.version).toBeNull();
  });
});
