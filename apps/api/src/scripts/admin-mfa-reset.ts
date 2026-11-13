/**
 * [REVIEW-2501-B B-S4-7] BREAK-GLASS: clear ONE admin's authenticator app and recovery codes, revoke every session
 * of that account, write an audit row, and email and text the admin. Interactive, run INSIDE the production API
 * container by someone who already holds the server (deploy/INCIDENT-RUNBOOK.md, deploy/PILOT-RUNBOOK.md):
 *
 *     docker compose -f deploy/docker-compose.yml exec api node dist/scripts/admin-mfa-reset.js
 *
 * (`exec` WITHOUT -T: it asks questions.) Nothing is passed on the command line, so no phone number lands in the
 * shell history. It asks for the admin, shows a masked summary, then the operator's name, the reason and a typed
 * confirmation naming the account. Exit 0 done, 1 failed (nothing changed), 2 refused, 3 not confirmed.
 * Logic and tests: modules/auth/admin-mfa-reset.ts.
 */
// FIRST: the secrets arrive as *_FILE; turn them into variables in this process's memory exactly as the server does.
import '../boot/secret-files';
import { createInterface } from 'node:readline/promises';
import Fastify from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { assertSafeBootConfig } from '../utils/boot-config';
import { adminMfaResetMain } from '../modules/auth/admin-mfa-reset';

async function main(): Promise<number> {
  // Same boot barrier as server.ts: this builds Fastify and AuthService outside it (F-027-15).
  assertSafeBootConfig();
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await adminMfaResetMain(app, {
      ask: (question) => rl.question(question),
      print: (line) => { process.stdout.write(`${line}\n`); },
    });
  } finally {
    rl.close();
    await app.close();
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => { process.stderr.write(`FAILED: ${error instanceof Error ? error.message : 'unexpected error'}\n`); process.exitCode = 1; },
);
