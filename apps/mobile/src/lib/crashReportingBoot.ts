/**
 * [L13 item 7] Imported FIRST by App.tsx so a crash during startup is caught.
 * Does nothing when the build carries no crash-report address.
 */
import * as Sentry from '@sentry/react-native';
import { crashEnvironment, otaUpdateTag, startCrashReporting, type CrashSdk } from './crashReporting';

declare const __DEV__: boolean | undefined;

const sdk: CrashSdk = {
  init: (options) => Sentry.init(options as Sentry.ReactNativeOptions),
  captureException: (error, hint) => Sentry.captureException(error, hint),
};

const crashReportingOn = startCrashReporting(sdk, {
  // @ts-expect-error Expo statically inlines this declared public build-time variable.
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  environment: crashEnvironment(
    // @ts-expect-error Expo statically inlines this declared public build-time variable.
    process.env.EXPO_PUBLIC_API_URL,
    typeof __DEV__ !== 'undefined' && __DEV__ === true,
  ),
});

// [OTA-CATCH-UP · REVIEW-2 L3 on #2431] Every crash says which JavaScript it came from (an update id, or "embedded").
if (crashReportingOn) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- read once, after crash reporting is on
    Sentry.setTag('ota_update_id', otaUpdateTag(require('expo-updates')));
  } catch { /* no updates module: the tag is left out */ }
}
