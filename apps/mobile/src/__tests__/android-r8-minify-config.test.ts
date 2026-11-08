import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// [ANDROID-R8 · build 13] Google Play flagged vc8 "DEX code optimization below threshold: Obfuscation 1%"
// (fix by Feb 2027). plugins/withAndroidReleaseMinify.js turns on R8 minification + resource shrinking for
// RELEASE builds through the two Gradle properties the Expo SDK 56 template reads, and adds the keep rules
// the native libraries do not ship themselves. This file pins: the plugin is registered, the compiled
// gradle.properties carry both switches, every keep rule is present (a dropped rule is a release-only
// crash no JS test can see), and the resources found only by a runtime name lookup are kept.
// A minified build is proven only by an EAS build + a device smoke test (calls, push, job ring, maps).
// ---------------------------------------------------------------------------

const MOBILE = process.cwd();
const plugin = createRequire(join(MOBILE, 'package.json'))('./plugins/withAndroidReleaseMinify.js') as {
  internals: {
    GRADLE_PROPERTIES: Record<string, string>;
    EXTRA_PROGUARD_RULES: string;
    BEGIN: string;
    END: string;
    RESOURCE_KEEP_FILE: string;
    applyGradleProperties(entries: Array<Record<string, string>>): Array<Record<string, string>>;
    mergeProguardRules(src: string): string;
    resourceKeeps(config: { plugins?: unknown[] }): string[];
    resourceKeepXml(config: { plugins?: unknown[] }): string;
    writeAndroidFiles(platformProjectRoot: string, config: { plugins?: unknown[] }): void;
  };
};
const I = plugin.internals;

// Compiles the real Android mods in introspect mode (in memory, writes nothing) in its own process: Expo's
// config loader caches app.config.ts per process (android-maps-key-manifest.test.ts does the same).
const COMPILE = `
const { createRequire } = require('node:module');
const path = require('node:path');
const root = process.cwd();
const fromExpo = createRequire(createRequire(path.join(root, 'package.json')).resolve('expo/package.json'));
const { getPrebuildConfigAsync } = fromExpo('@expo/prebuild-config');
const { compileModsAsync } = fromExpo('@expo/config-plugins');
(async () => {
  const { exp } = await getPrebuildConfigAsync(root, { platforms: ['android'] });
  const out = await compileModsAsync(exp, { projectRoot: root, introspect: true, platforms: ['android'], assertMissingModProviders: false });
  const props = out._internal.modResults.android.gradleProperties.filter((e) => e.type === 'property');
  process.stdout.write('\\n@@OUT@@' + JSON.stringify({ props, plugins: exp.plugins }));
})().catch((e) => { console.error(e); process.exit(1); });
`;

function compileAndroid(): { props: Array<{ key: string; value: string }>; plugins: unknown[] } {
  const inherited = { ...process.env };
  delete inherited['GOOGLE_SERVICES_JSON'];
  const env = { ...inherited, EAS_BUILD_PLATFORM: 'android', ANDROID_GOOGLE_MAPS_API_KEY: 'qa-test-maps-key-not-real' };
  const stdout = execFileSync(process.execPath, ['-e', COMPILE], { cwd: MOBILE, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(stdout.slice(stdout.lastIndexOf('@@OUT@@') + '@@OUT@@'.length));
}

// Every rule, verbatim. Each one is a release-only crash or a broken feature if it goes missing.
const REQUIRED_RULES = [
  // Twilio Voice Android SDK (JNI), from twilio/voice-quickstart-android app/proguard-rules.pro
  '-keep class com.twilio.** { *; }',
  '-keep class tvo.webrtc.** { *; }',
  '-dontwarn tvo.webrtc.**',
  '-keep class com.twilio.voice.** { *; }',
  '-keepattributes InnerClasses',
  '-dontwarn android.content.pm.PackageManager$ApplicationInfoFlags',
  '-dontwarn android.content.pm.PackageManager$PackageInfoFlags',
  // @twilio/voice-react-native-sdk ships no consumer rules; SwiftCallGate.kt lives in its package
  '-keep class com.twiliovoicereactnative.** { *; }',
  // Swift's own router + call intents
  '-keep class gy.swift.app.calls.** { *; }',
  // react-native-webview @JavascriptInterface
  '@android.webkit.JavascriptInterface <methods>;',
  // react-native-gesture-handler reflection
  '-keep class com.swmansion.gesturehandler.RNGestureHandlerPackage$$ReactModuleInfoProvider { <init>(); }',
  // expo-modules-core reflection
  '-keep class inline.modules.ExpoInlineModulesList { <init>(); }',
  // expo-modules-core headless app loader: named only in its manifest meta-data, loaded by Class.forName in
  // AppLoaderProvider.kt; expo-task-manager TaskService.java needs it for background location after process death
  '-keep class expo.modules.adapters.react.apploader.RNHeadlessAppLoader { <init>(); }',
];

const fromMobile = createRequire(join(MOBILE, 'package.json'));
const pkgDir = (name: string) => join(fromMobile.resolve(`${name}/package.json`), '..');
const JOB_RING_PLUGINS = [['expo-notifications', { sounds: ['./assets/sounds/swift_job_ring.wav'] }]];

describe('Android release builds are minified and shrunk (R8)', () => {
  it('app.config.ts registers the plugin', () => {
    expect(readFileSync(join(MOBILE, 'app.config.ts'), 'utf8')).toContain("'./plugins/withAndroidReleaseMinify.js'");
  });

  it('the compiled gradle.properties turn on minify AND resource shrinking for release', () => {
    const { props } = compileAndroid();
    const value = (key: string) => props.filter((p) => p.key === key).map((p) => p.value);
    expect(value('android.enableMinifyInReleaseBuilds')).toEqual(['true']);
    expect(value('android.enableShrinkResourcesInReleaseBuilds')).toEqual(['true']);
  }, 90_000);

  it('the properties are exactly the two the SDK 56 template reads', () => {
    expect(I.GRADLE_PROPERTIES).toEqual({
      'android.enableMinifyInReleaseBuilds': 'true',
      'android.enableShrinkResourcesInReleaseBuilds': 'true',
    });
    // The installed Expo template's app/build.gradle (what prebuild writes) must still read both, and wire
    // them into the release build type with the proguard-rules.pro this plugin appends to.
    const templateTgz = join(createRequire(join(MOBILE, 'package.json')).resolve('expo/package.json'), '..', 'template.tgz');
    const gradle = execFileSync('tar', ['-xzOf', templateTgz, 'package/android/app/build.gradle'], { encoding: 'utf8' });
    expect(gradle).toContain("findProperty('android.enableMinifyInReleaseBuilds')");
    expect(gradle).toContain("findProperty('android.enableShrinkResourcesInReleaseBuilds')");
    expect(gradle).toMatch(/minifyEnabled enableMinifyInReleaseBuilds/);
    expect(gradle).toMatch(/shrinkResources enableShrinkResources\.toBoolean\(\)/);
    expect(gradle).toContain('"proguard-rules.pro"');
  });

  it('applyGradleProperties replaces a false value instead of adding a second line', () => {
    const out = I.applyGradleProperties([
      { type: 'comment', value: 'x' },
      { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'false' },
      { type: 'property', key: 'hermesEnabled', value: 'true' },
    ]);
    const minify = out.filter((e) => e['key'] === 'android.enableMinifyInReleaseBuilds');
    expect(minify).toEqual([{ type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'true' }]);
    expect(out.find((e) => e['key'] === 'hermesEnabled')).toBeDefined();
    expect(I.applyGradleProperties(out)).toEqual(out);
  });

  it('every keep rule is in the generated proguard-rules.pro, once, after the template rules', () => {
    const template = '# react-native-reanimated\n-keep class com.swmansion.reanimated.** { *; }\n\n# Add any project specific keep options here:\n';
    const merged = I.mergeProguardRules(template);
    expect(merged.startsWith(template)).toBe(true);
    for (const rule of REQUIRED_RULES) expect(merged, rule).toContain(rule);
    expect(I.mergeProguardRules(merged)).toBe(merged);
    expect(merged.split(I.BEGIN)).toHaveLength(2);
  });

  it('a stale generated block is replaced, never doubled', () => {
    const stale = `head\n\n${I.BEGIN}\n-keep class old.** { *; }\n${I.END}\ntail\n`;
    const merged = I.mergeProguardRules(stale);
    expect(merged).not.toContain('old.**');
    expect(merged).toContain('head');
    expect(merged).toContain('tail');
    expect(merged.split(I.BEGIN)).toHaveLength(2);
  });

  it('resources looked up only by name are kept: the job ring sound and the call notification icons/texts', () => {
    const { plugins } = compileAndroid();
    const keeps = I.resourceKeeps({ plugins });
    expect(keeps).toEqual([
      '@raw/swift_job_ring',
      '@drawable/incoming_call_small_icon',
      '@drawable/outgoing_call_small_icon',
      '@drawable/answered_call_small_icon',
      '@string/incoming_call_caller_name_text',
      '@string/outgoing_call_caller_name_text',
      '@string/answered_call_caller_name_text',
    ]);
    const xml = I.resourceKeepXml({ plugins });
    expect(xml).toContain('xmlns:tools="http://schemas.android.com/tools"');
    expect(xml).toContain(`tools:keep="${keeps.join(',')}"`);
    // Expo's bundler writes res/raw/keep.xml for JS assets; ours must not collide with it.
    expect(I.RESOURCE_KEEP_FILE).not.toBe('keep.xml');
  }, 90_000);

  it('the six call-SDK resources kept by name really exist in the installed SDK, under those names', () => {
    const sdk = join(pkgDir('@twilio/voice-react-native-sdk'), 'android/src/main');
    const keeps = I.resourceKeeps({ plugins: JOB_RING_PLUGINS }).filter((k) => !k.startsWith('@raw/'));
    expect(keeps).toHaveLength(6);
    const drawables = readdirSync(join(sdk, 'res/drawable')).map((f) => f.replace(/\.[^.]+$/, ''));
    const strings = readFileSync(join(sdk, 'res/values/strings.xml'), 'utf8');
    const lookup = readFileSync(join(sdk, 'java/com/twiliovoicereactnative/NotificationUtility.java'), 'utf8');
    for (const keep of keeps) {
      const [type, name] = keep.slice(1).split('/') as [string, string];
      if (type === 'drawable') expect(drawables, keep).toContain(name);
      else expect(strings, keep).toContain(`name="${name}"`);
      // ...and are looked up by exactly that string (getIdentifier), which is why they need the keep.
      expect(lookup, keep).toContain(`"${name}"`);
    }
  });

  it('the plugin refuses a config with no expo-notifications sounds (the job-ring keep cannot vanish silently)', () => {
    expect(() => I.resourceKeeps({ plugins: [] })).toThrow(/no expo-notifications sounds/);
    expect(() => I.resourceKeeps({ plugins: [['expo-notifications', { sounds: [] }]] })).toThrow(/no expo-notifications sounds/);
    expect(() => I.resourceKeeps({ plugins: ['expo-notifications'] })).toThrow(/no expo-notifications sounds/);
  });

  it('the file-writing step writes proguard-rules.pro and res/raw/swift_resource_keep.xml (twice = same files)', () => {
    const root = mkdtempSync(join(tmpdir(), 'swift-r8-'));
    try {
      const template = '# react-native-reanimated\n-keep class com.swmansion.reanimated.** { *; }\n';
      mkdirSync(join(root, 'app'), { recursive: true });
      writeFileSync(join(root, 'app/proguard-rules.pro'), template);
      I.writeAndroidFiles(root, { plugins: JOB_RING_PLUGINS });
      const rules = readFileSync(join(root, 'app/proguard-rules.pro'), 'utf8');
      const keepXml = readFileSync(join(root, 'app/src/main/res/raw/swift_resource_keep.xml'), 'utf8');
      expect(rules.startsWith(template)).toBe(true);
      for (const rule of REQUIRED_RULES) expect(rules, rule).toContain(rule);
      expect(keepXml).toBe(I.resourceKeepXml({ plugins: JOB_RING_PLUGINS }));
      expect(keepXml).toContain('tools:keep="@raw/swift_job_ring,@drawable/incoming_call_small_icon,');
      I.writeAndroidFiles(root, { plugins: JOB_RING_PLUGINS });
      expect(readFileSync(join(root, 'app/proguard-rules.pro'), 'utf8')).toBe(rules);
      expect(readFileSync(join(root, 'app/src/main/res/raw/swift_resource_keep.xml'), 'utf8')).toBe(keepXml);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Android release profiles upload the R8 mapping/usage/seeds files; production keeps the DSN off', () => {
    type Profile = { android?: { buildArtifactPaths?: string[] }; env?: Record<string, string> };
    const eas = JSON.parse(readFileSync(join(MOBILE, 'eas.json'), 'utf8')) as { build: Record<string, Profile> };
    for (const name of ['preview', 'staging', 'production']) {
      expect(eas.build[name]?.android?.buildArtifactPaths, name).toEqual(['android/app/build/outputs/mapping/release/*']);
    }
    expect(eas.build['production']?.env?.['EXPO_PUBLIC_SENTRY_DSN']).toBe('off');
  });
});
