/* eslint-env node */
/**
 * [ANDROID-R8 · build 13] R8 minification + resource shrinking for Android RELEASE builds.
 *
 * Why: Google Play flagged vc8 "DEX code optimization below threshold: Obfuscation 1%" (fix by Feb 2027).
 *
 * How: the Expo SDK 56 template's android/app/build.gradle already reads two Gradle properties for the
 * release build type only (debug / dev-client builds are untouched):
 *   minifyEnabled  <- android.enableMinifyInReleaseBuilds          (default false)
 *   shrinkResources <- android.enableShrinkResourcesInReleaseBuilds (default false)
 *   proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
 * These are the same properties expo-build-properties writes; that package is not a dependency of this
 * app, so this plugin sets them itself (no new package, no lockfile change).
 *
 * Keep rules: most native libraries ship consumer rules inside their own package and need nothing here
 * (react-native, reanimated, worklets, svg, expo, expo-modules-core, expo-notifications, expo-updates,
 * expo-location, expo-image, expo-task-manager in node_modules; Firebase, Google Play services Maps and
 * Sentry Android inside their AARs). EXTRA_PROGUARD_RULES adds ONLY what is missing; every rule says why.
 *
 * Resources: shrinkResources removes resources nothing references. A resource looked up at runtime by a
 * name that only JavaScript knows survives only if a keep file names it. Expo's own bundler writes one for
 * every JS asset (res/raw/keep.xml); RESOURCE_KEEP_XML names the rest (see resourceKeeps()).
 */
const path = require('node:path');
const fs = require('node:fs');
const { withGradleProperties, withDangerousMod, createRunOncePlugin } = require('expo/config-plugins');

const TAG = 'swift-android-release-minify';

const GRADLE_PROPERTIES = {
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
};

const BEGIN = '# @generated begin swift-android-release-minify (plugins/withAndroidReleaseMinify.js) - do not edit';
const END = '# @generated end swift-android-release-minify';

const EXTRA_PROGUARD_RULES = `# --- Twilio Voice Android SDK (com.twilio:voice-android 6.10.3, pulled in by @twilio/voice-react-native-sdk 1.8.1).
# Native code (JNI) calls back into these Java classes by name. Rules copied from Twilio's own
# twilio/voice-quickstart-android app/proguard-rules.pro.
-keep class com.twilio.** { *; }
-keep class tvo.webrtc.** { *; }
-dontwarn tvo.webrtc.**
-keep class com.twilio.voice.** { *; }
-keepattributes InnerClasses
# Same source, "needed with AGP 8.x" (React Native 0.85 builds with AGP 8.12).
-dontwarn android.content.pm.PackageManager$ApplicationInfoFlags
-dontwarn android.content.pm.PackageManager$PackageInfoFlags

# --- @twilio/voice-react-native-sdk 1.8.1 (package com.twiliovoicereactnative).
# Ships NO consumer rules (its android/build.gradle has no consumerProguardFiles, and Twilio's own test app
# builds with enableProguardInReleaseBuilds = false), so it has never been shrunk upstream: keep it whole.
# Swift's SwiftCallGate.kt (plugins/withSwiftInAppCalls.js) lives in this package and uses package-private
# members, and SwiftCallIntents.kt starts com.twiliovoicereactnative.VoiceService by its class-name string.
-keep class com.twiliovoicereactnative.** { *; }

# --- Swift's own native code written by plugins/withSwiftInAppCalls.js (gy.swift.app.calls):
# SwiftMessagingService (the one Firebase receiver, named in the manifest) and SwiftCallIntents.
-keep class gy.swift.app.calls.** { *; }

# --- react-native-webview 13.16.1: RNCWebView.java postMessage() is an @JavascriptInterface method that
# the page calls by name. The library ships no consumer rules.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# --- react-native-gesture-handler 2.31.2: RNGestureHandlerPackage.kt loads
# RNGestureHandlerPackage$$ReactModuleInfoProvider with Class.forName(...).getDeclaredConstructor()
# .newInstance(). The library ships no consumer rules.
-keep class com.swmansion.gesturehandler.RNGestureHandlerPackage$$ReactModuleInfoProvider { <init>(); }

# --- expo-modules-core 56: AppContext.kt loads inline.modules.ExpoInlineModulesList with
# Class.forName(...).getConstructor().newInstance() and catches only ClassNotFoundException, so a stripped
# constructor would crash at start. Not covered by expo-modules-core's own rules. (Absent class = no-op.)
-keep class inline.modules.ExpoInlineModulesList { <init>(); }

# --- expo-modules-core 56: the headless app loader is named ONLY in expo-modules-core's AndroidManifest.xml
# meta-data (org.unimodules.core.AppLoader#react-native-headless) and loaded by AppLoaderProvider.kt with
# Class.forName(...).getDeclaredConstructor().newInstance(). expo-task-manager's TaskService.java asks for it
# when a background task (services/backgroundLocation.ts, the mover location task) fires after the process
# died; a renamed or stripped class crashes that path. Its @DoNotStrip constructor alone does not keep the name.
-keep class expo.modules.adapters.react.apploader.RNHeadlessAppLoader { <init>(); }`;

/** Notification sounds the expo-notifications plugin copies into res/raw, as `@raw/<name>`. */
function notificationSoundKeeps(config) {
  const entry = (config.plugins || []).find((p) => Array.isArray(p) && p[0] === 'expo-notifications');
  const sounds = (entry && entry[1] && entry[1].sounds) || [];
  // The job ring's channel sound would be shrunk away without its keep: never let it vanish silently.
  if (sounds.length === 0) throw new Error(`${TAG}: no expo-notifications sounds in the config, so the job-ring sound keep would vanish`);
  return sounds.map((file) => `@raw/${path.basename(file, path.extname(file))}`);
}

/**
 * Resources found only by a runtime name lookup (Resources.getIdentifier):
 * - each expo-notifications sound: the 'job_offers' channel names its sound from JavaScript
 *   (services/jobRingCapability.ts) and expo-notifications SoundResolver.kt looks it up in res/raw by name;
 * - the call SDK's notification icons and texts: NotificationUtility.java looks them up by name. A
 *   notification with no small icon is rejected by Android, so a lost icon breaks the incoming-call screen.
 */
function resourceKeeps(config) {
  return [
    ...notificationSoundKeeps(config),
    '@drawable/incoming_call_small_icon',
    '@drawable/outgoing_call_small_icon',
    '@drawable/answered_call_small_icon',
    '@string/incoming_call_caller_name_text',
    '@string/outgoing_call_caller_name_text',
    '@string/answered_call_caller_name_text',
  ];
}

/** res/raw keep file (read by the resource shrinker, not packaged). Not named keep.xml: Expo's bundler owns that one. */
const RESOURCE_KEEP_FILE = 'swift_resource_keep.xml';
function resourceKeepXml(config) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- @generated by plugins/withAndroidReleaseMinify.js: resources looked up by name at runtime. -->
<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="${resourceKeeps(config).join(',')}" />
`;
}

/** gradle.properties (parsed entries): set both release properties to true. Idempotent. */
function applyGradleProperties(entries) {
  const out = entries.filter((e) => !(e.type === 'property' && Object.hasOwn(GRADLE_PROPERTIES, e.key)));
  for (const [key, value] of Object.entries(GRADLE_PROPERTIES)) out.push({ type: 'property', key, value });
  return out;
}

/** proguard-rules.pro: append the rules once, between markers (replaced on re-run). Idempotent. */
function mergeProguardRules(src) {
  const block = `${BEGIN}\n${EXTRA_PROGUARD_RULES}\n${END}\n`;
  const start = src.indexOf(BEGIN);
  if (start !== -1) {
    const end = src.indexOf(END, start);
    if (end === -1) throw new Error(`${TAG}: proguard-rules.pro has a begin marker without an end marker`);
    return src.slice(0, start) + block + src.slice(end + END.length).replace(/^\n/, '');
  }
  return `${src.replace(/\n*$/, '\n')}\n${block}`;
}

/** The file-writing step: proguard-rules.pro (merged) + res/raw keep file, under an android/ project root. */
function writeAndroidFiles(platformProjectRoot, config) {
  const appDir = path.join(platformProjectRoot, 'app');
  const rulesPath = path.join(appDir, 'proguard-rules.pro');
  const current = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8') : '';
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(rulesPath, mergeProguardRules(current));
  const rawDir = path.join(appDir, 'src/main/res/raw');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, RESOURCE_KEEP_FILE), resourceKeepXml(config));
}

const withAndroidReleaseMinify = (config) => {
  config = withGradleProperties(config, (cfg) => {
    cfg.modResults = applyGradleProperties(cfg.modResults);
    return cfg;
  });
  config = withDangerousMod(config, ['android', (cfg) => {
    writeAndroidFiles(cfg.modRequest.platformProjectRoot, cfg);
    return cfg;
  }]);
  return config;
};

module.exports = createRunOncePlugin(withAndroidReleaseMinify, TAG, '1');
module.exports.internals = {
  GRADLE_PROPERTIES, EXTRA_PROGUARD_RULES, BEGIN, END, RESOURCE_KEEP_FILE,
  applyGradleProperties, mergeProguardRules, resourceKeeps, resourceKeepXml, writeAndroidFiles,
};
