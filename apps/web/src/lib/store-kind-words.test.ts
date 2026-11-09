import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { orderReadyEstimate, readyTimeLabel, storeKindWords } from './store-kind-words';

// [STORE-WORDS · owner 9 Nov 2026] The website and the app name a store's things by the store's kind
// with ONE set of words. The app's file is pure TypeScript; the web keeps a byte-identical copy and
// this census fails the moment the two differ.
const APP = join(__dirname, '..', '..', '..', 'mobile', 'src', 'lib', 'storeKindWords.ts');
const WEB = join(__dirname, 'store-kind-words.ts');

describe('store kind words are the app\'s words', () => {
  it('the web copy is byte-identical to the app\'s file', () => {
    expect(readFileSync(WEB, 'utf8')).toBe(readFileSync(APP, 'utf8'));
  });

  it('a shop never gets a kitchen\'s words; a restaurant keeps its own', () => {
    expect(storeKindWords('STORE').itemNotePlaceholder).toBe('e.g. size, colour, gift wrap');
    expect(readyTimeLabel('STORE', 20)).toBe('Ready in about 20 min');
    expect(orderReadyEstimate('STORE', 20)).toBe('Ready in about 20 min');
    expect(readyTimeLabel('RESTAURANT', 20)).toBe('20 min prep');
    expect(orderReadyEstimate('RESTAURANT', 20)).toBe('About 20 min prep');
  });
});
