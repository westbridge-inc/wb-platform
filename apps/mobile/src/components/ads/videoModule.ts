// expo-video is a native module: a stale binary without it must degrade to the poster banner, never crash at import
// [reference_swift_native_module_crash] — hence the guarded require. Its own file so a test can hand in a stand-in.
let loaded: typeof import('expo-video') | null = null;
try {
  loaded = require('expo-video');
} catch {
  loaded = null;
}

export const videoModule = loaded;
