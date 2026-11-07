/**
 * [G11] Swift's two store pages: the App Store (app id 6815507102, bundle
 * gy.swift.app) and Google Play (package gy.swift.app). The same app and
 * listing the phone app's update-required screen opens
 * (apps/mobile/src/lib/appVersionGate.ts STORE_URLS); a test pins them. Shown
 * only while the server's SWIFT_APP_STORES switch is live (lib/launch-switch.ts).
 *
 * [WEB-APPBAR · owner 7 Nov 2026] The website's App Store link names the Guyana
 * storefront (/gy/). Swift is listed in Guyana only, so the storefront-less
 * address shows "not found" in a desktop browser outside Guyana; on a phone the
 * App Store opens either one in the visitor's own store.
 */
export const APP_STORE_URL = 'https://apps.apple.com/gy/app/swiftgy/id6815507102';
export const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=gy.swift.app';
