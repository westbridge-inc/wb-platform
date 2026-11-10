import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicRoutes } from '../modules/public/public.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { CARD_CHECKOUT_PLATFORMS_KEY } from '../modules/billing/card-checkout-switch';

// ---------------------------------------------------------------------------
// [CARDS-SWITCH-ON · review #2465-B F4] The public site lists Visa and Mastercard only while a partner can actually
// pay the weekly fee by card on this server. GET /api/v1/public/capabilities says so as cardPayments: 'live' exactly
// when the server's own card switches are on (v2 on, not killed, the real provider, live cards) AND the card's
// platform switch leaves at least one platform open; anything else — and any failure to read it — is 'soon'.
// Uncached, like adsEnabled beside it; while cards are off nothing is read from the database.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let row: { value: unknown } | null;
let readFails = false;
const findUnique = vi.fn(async ({ where }: { where: { key: string } }) => {
  if (readFails) throw new Error('database unavailable');
  expect(where.key).toBe(CARD_CHECKOUT_PLATFORMS_KEY);
  return row;
});

const CARDS_ON = {
  NODE_ENV: 'test', PAYMENT_PROVIDER: 'disabled', CARD_RAIL_KILL: '0', CARD_RAIL_V2: '1',
  CARD_RAIL_PROVIDER: 'powertranz', CARD_RAIL_ENVIRONMENT: 'live',
};

beforeEach(async () => {
  row = null;
  readFails = false;
  findUnique.mockClear();
  app = Fastify();
  app.decorate('prisma', { platformConfig: { findUnique } } as unknown as FastifyInstance['prisma']);
  registerErrorHandler(app);
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  await app.ready();
});
afterEach(async () => { await app.close(); vi.unstubAllEnvs(); });

async function cardPayments(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const response = await app.inject('/api/v1/public/capabilities');
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return (response.json() as { data: { cardPayments: unknown } }).data.cardPayments;
}

describe('[CARDS-SWITCH-ON] GET /public/capabilities → cardPayments follows the server', () => {
  it('cards off (the launch default): soon, and nothing is read from the database', async () => {
    expect(await cardPayments({ CARD_RAIL_KILL: '1', CARD_RAIL_V2: '0' })).toBe('soon');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('cards on with a platform open: live (no row = Android and the website open, iPhone off)', async () => {
    expect(await cardPayments(CARDS_ON)).toBe('live');
    for (const value of [{ ios: true, android: true, web: true }, { ios: false }, { android: false }, { web: false, android: false, ios: true }]) {
      row = { value };
      expect(await cardPayments(CARDS_ON), JSON.stringify(value)).toBe('live');
    }
  });

  it('cards on but every platform closed (or a row of the wrong type): soon', async () => {
    for (const value of [{ ios: false, android: false, web: false }, { android: false, web: false }, ['ios'], 'on', { ios: 'true', android: 'yes', web: 1 }]) {
      row = { value };
      expect(await cardPayments(CARDS_ON), JSON.stringify(value)).toBe('soon');
    }
  });

  it('the kill switch, v2 off, a test system or no provider: soon, nothing read', async () => {
    for (const patch of [
      { CARD_RAIL_KILL: '1' }, { CARD_RAIL_V2: '0' }, { CARD_RAIL_ENVIRONMENT: 'sandbox' }, { CARD_RAIL_PROVIDER: 'simulator' }, { CARD_RAIL_PROVIDER: undefined },
    ]) {
      findUnique.mockClear();
      vi.unstubAllEnvs();
      expect(await cardPayments({ ...CARDS_ON, ...patch }), JSON.stringify(patch)).toBe('soon');
      expect(findUnique, JSON.stringify(patch)).not.toHaveBeenCalled();
    }
  });

  it('the switch row cannot be read: soon, and the capabilities still answer', async () => {
    readFails = true;
    expect(await cardPayments(CARDS_ON)).toBe('soon');
  });
});
