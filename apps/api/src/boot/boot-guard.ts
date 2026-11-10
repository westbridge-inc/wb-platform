import './secret-files';
import { assertSafeBootConfig } from '../utils/boot-config';

/**
 * [CARDS-SWITCH-ON · reviews #2465-A F1 / B-B4] `node dist/boot/boot-guard.js` — the API's own boot guard
 * (assertSafeBootConfig), run alone. deploy/pilot-up.sh runs it in a one-off container of the image it just built,
 * once as api and once as worker, with Compose's own settings for each, BEFORE anything is stopped: a configuration
 * the API would refuse never reaches the swap. The secret files are loaded first (./secret-files, as server.ts and
 * worker.ts do; an unreadable one exits there, naming the setting). Prints the refusal exactly as the server would
 * (a setting's name, never a value) or one OK line; exit 0 only when the guard passes. Opens no connection.
 */
try {
  assertSafeBootConfig();
  // eslint-disable-next-line no-console
  console.log('OK boot guard: this configuration starts');
  process.exit(0);
} catch (error) {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : 'FATAL: the boot guard could not run. Refusing to start.');
  process.exit(1);
}
