/**
 * [COMPANY-DOCS · owner 10 Nov 2026] swiftgy.com, for links the app opens in the browser (the one-page letters of authority):
 * the same value services/api.ts and the deep-link policy use (EXPO_PUBLIC_WEB_URL), in a module with no network or
 * React Native import, so a screen can name a website page without loading the API client.
 */
declare const __DEV__: boolean | undefined;

export const WEBSITE_URL = process.env['EXPO_PUBLIC_WEB_URL'] ?? (typeof __DEV__ !== 'undefined' && __DEV__ ? 'http://localhost:3001' : 'https://swiftgy.com');
