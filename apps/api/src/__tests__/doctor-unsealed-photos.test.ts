/**
 * [FABLE-02 F5 · 13 Nov 2026] Selfies stored before sealing shipped stay plain images until photos:seal-existing runs
 * (held by the owner until its fix lands), and nothing counted them. deploy/doctor.sh now does, read-only, and warns.
 * This test runs the doctor's OWN query (read from the script) against real rows: the same shapes the seal pass treats
 * as stored selfies (users.avatar in the person's own avatars folder; a liveness selfie in their liveness folder), and
 * nothing that is sealed (.enc) or not a stored selfie (a seed URL).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { PrismaClient } from '@prisma/client';

const REPO = join(__dirname, '..', '..', '..', '..');
const doctor = readFileSync(join(REPO, 'deploy', 'doctor.sh'), 'utf8');
const prisma = new PrismaClient();
const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const users: string[] = [];

function doctorQuery(): string {
  const m = /^\s*UNSEALED_PHOTOS_SQL="(.+)"$/m.exec(doctor);
  if (!m) return '';
  return m[1]!.replace(/\\"/g, '"');
}
const count = async () => Number(((await prisma.$queryRawUnsafe(doctorQuery())) as Array<Record<string, unknown>>)[0]!['count'] ?? NaN);

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  if (users.length) {
    await prisma.livenessCheck.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
  await prisma.$disconnect();
});

describe('deploy/doctor.sh counts stored selfies that are not sealed', () => {
  it('runs the query and warns on a non-zero count, naming the held script', () => {
    expect(doctorQuery()).not.toBe('');
    expect(doctor).toMatch(/PLAIN=\$\(db_query "\$UNSEALED_PHOTOS_SQL"/);
    expect(doctor).toMatch(/warn "\$PLAIN stored selfie\(s\) are not sealed[^"]*photos:seal-existing/);
  });

  it('counts a plain stored selfie and a plain liveness selfie; never a sealed one or a seed URL', async () => {
    const before = await count();
    expect(Number.isFinite(before)).toBe(true);
    const make = async (n: number) => {
      const u = await prisma.user.create({ data: { phone: `+59276${NUM}${n}`, firstName: 'Seal', lastName: `Check${RUN}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER' } });
      users.push(u.id);
      return u.id;
    };
    const plain = await make(1);
    await prisma.user.update({ where: { id: plain }, data: { avatar: `avatars/${plain}/old.jpg` } });
    const sealed = await make(2);
    await prisma.user.update({ where: { id: sealed }, data: { avatar: `avatars/${sealed}/new.jpg.enc` } });
    const seeded = await make(3);
    await prisma.user.update({ where: { id: seeded }, data: { avatar: 'https://example.test/portrait.png' } });
    await prisma.livenessCheck.create({ data: { userId: sealed, profile: 'RIDER', selfieUrl: `liveness/${sealed}/shift.jpg`, outcome: 'PASS' } });
    await prisma.livenessCheck.create({ data: { userId: plain, profile: 'RIDER', selfieUrl: `liveness/${plain}/shift.jpg.enc`, outcome: 'PASS' } });
    expect(await count()).toBe(before + 2);
  });
});
