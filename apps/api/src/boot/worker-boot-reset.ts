/**
 * [REVIEW-2503-A D-3] Imported by dist/worker.js right after the secret files, before anything else
 * loads. After a restart the container's /tmp still holds the PREVIOUS worker's boot record (same pid,
 * same boot time) until this worker writes its own (recordWorkerBoot, in main(), after every import).
 * A container probe in that window would take the starting worker for its predecessor and could
 * SIGKILL it on the old SIGTERM. Forgetting the record first closes the window: without a record the
 * probe never signals anything. Dependency-free on purpose: it must load in milliseconds.
 */
import { unlinkSync } from 'node:fs';

/** The same path as boot/worker-probe.ts WORKER_BOOT_FILE (not imported, so nothing heavy loads first). */
export const WORKER_BOOT_FILE_PATH = '/tmp/swift-worker-boot';

export function forgetWorkerBoot(file = WORKER_BOOT_FILE_PATH): void {
  try {
    unlinkSync(file);
  } catch {
    // no record (the first start), or not removable: the probe then reads the old one, as before
  }
}

forgetWorkerBoot();
