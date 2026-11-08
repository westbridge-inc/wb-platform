import { describe, expect, it } from 'vitest';
import { rootEntryGate } from '../navigation/rootEntryGate';
import {
  INTRO_TIMELINE,
  introEndsAtMs,
  introModeAtLaunch,
  introPlan,
  type IntroPlan,
  type LaunchIntroState,
} from './launchIntro';

// [APP-INTRO · owner 8 Nov 2026] Who sees the brand intro, and for how long.

const signedOut: LaunchIntroState = { isAuthenticated: false, wantsAuth: false, intent: null, hasSeenIntro: false };

describe('introModeAtLaunch', () => {
  it('first launch, signed out, no door picked: the full intro', () => {
    expect(introModeAtLaunch(signedOut)).toBe('full');
  });

  it('back on the welcome after seeing it once: the quick dissolve', () => {
    expect(introModeAtLaunch({ ...signedOut, hasSeenIntro: true })).toBe('quick');
  });

  it.each<[string, Partial<LaunchIntroState>]>([
    ['signed in', { isAuthenticated: true, intent: 'customer' }],
    ['signed in, intent not yet restored', { isAuthenticated: true }],
    ['signed in, first launch of this install', { isAuthenticated: true, intent: 'mover', hasSeenIntro: false }],
    ['a guest browsing as a customer', { intent: 'customer' }],
    ['a partner sign-up under way', { intent: 'mover' }],
    ['a business sign-up under way', { intent: 'vendor' }],
    ['an advertiser', { intent: 'advertiser' }],
    ['sign-in asked for', { wantsAuth: true }],
  ])('%s: none', (_who, patch) => {
    expect(introModeAtLaunch({ ...signedOut, ...patch })).toBe('none');
    expect(introModeAtLaunch({ ...signedOut, ...patch, hasSeenIntro: true })).toBe('none');
  });

  it('plays exactly when the app opens on the welcome screen (rootEntryGate role-picker), never elsewhere', () => {
    const intents = [null, 'customer', 'mover', 'vendor', 'advertiser'] as const;
    for (const isAuthenticated of [false, true]) {
      for (const wantsAuth of [false, true]) {
        for (const intent of intents) {
          const gate = rootEntryGate({
            isAuthenticated, wantsAuth, intent, countryCode: 'GY', anyPreview: false, needsSelfie: false, hasUser: isAuthenticated,
          });
          const mode = introModeAtLaunch({ isAuthenticated, wantsAuth, intent, hasSeenIntro: false });
          expect(mode !== 'none', `${isAuthenticated}/${wantsAuth}/${intent} → ${gate}`).toBe(gate === 'role-picker' && !isAuthenticated);
        }
      }
    }
  });
});

describe('introPlan and the timeline', () => {
  it('Reduce Motion swaps the movement for a still frame', () => {
    expect(introPlan('full', false)).toBe('full');
    expect(introPlan('quick', false)).toBe('quick');
    expect(introPlan('full', true)).toBe('still');
    expect(introPlan('quick', true)).toBe('stillQuick');
  });

  it('every plan is over fast: full about a second, the rest well under', () => {
    const ends = Object.fromEntries((['full', 'quick', 'still', 'stillQuick'] as IntroPlan[]).map((p) => [p, introEndsAtMs(p)]));
    expect(ends['full']).toBeGreaterThanOrEqual(900);
    expect(ends['full']).toBeLessThanOrEqual(1200);
    expect(ends['quick']).toBeLessThanOrEqual(350);
    expect(ends['still']).toBeLessThanOrEqual(ends['full']!);
    expect(ends['stillQuick']).toBeLessThanOrEqual(350);
    expect(INTRO_TIMELINE.skip.duration).toBeLessThanOrEqual(200);
  });

  it('the full intro ends with its dissolve: nothing is still arriving when the welcome shows', () => {
    const { mark, wordmark, tagline, reveal } = INTRO_TIMELINE.full;
    const arrived = Math.max(...[mark, wordmark, tagline].map((s) => s.delay + s.duration));
    expect(reveal.delay).toBeGreaterThanOrEqual(arrived);
    expect(introEndsAtMs('full')).toBe(reveal.delay + reveal.duration);
  });
});
