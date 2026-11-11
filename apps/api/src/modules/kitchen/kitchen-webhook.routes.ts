import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import { log } from '../../utils/logger';
import { kitchenWebhookSecretFor } from './kitchen-credentials';
import { dragontailIntegrationEnabled, dragontailSettings } from './kitchen-switch';
import { applyKitchenEvents } from './kitchen-sync';
import { dragontailEvents, dragontailTime } from './dragontail/dragontail-mapper';

/**
 * [KITCHEN-INTEGRATION] Dragontail's webhook: POST /api/v1/integrations/dragontail/notifications/:vendorIntegrationId
 * with the PosNotification body ({ time, orders: Notification[] }).
 *
 * The spec defines no webhook authentication, so it is a setting (TODO-CONFIRM): a shared secret in a header,
 * an HMAC-SHA256 of the raw body (hex) in a header, or both (DRAGONTAIL_WEBHOOK_CHECK). The secret is the
 * credentials-secret entry under the connection's OWN derived webhook reference, never a value on the row.
 *
 *   switch off, unknown or disabled connection → 404 (nothing to find)
 *   no webhook secret configured                → 503 (nothing recorded)
 *   wrong / missing proof                       → 403 (nothing recorded)
 *   accepted                                    → 200 { time, status: "ok", rowCount } (the spec's answer)
 *
 * Rate-limited and body-capped; the body is never logged (it carries customer order ids and times only, but the
 * rule is the same as every webhook here). The poller is the fallback for a webhook that never arrives.
 */

export const KITCHEN_WEBHOOK_BODY_LIMIT = 256 * 1024;
const KITCHEN_WEBHOOK_RATE = { max: 600, timeWindow: '1 minute' } as const;

function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The HMAC-SHA256 of the raw body under the secret, hex. */
export function kitchenWebhookSignature(secret: string, raw: string): string {
  return crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
}

/** Does the request carry the proof the settings ask for? */
export function kitchenWebhookAuthentic(
  headers: Record<string, unknown>,
  raw: string,
  secret: string,
  settings: Pick<ReturnType<typeof dragontailSettings>, 'webhookCheck' | 'webhookHeader' | 'webhookSignatureHeader'>,
): boolean {
  const shared = sameSecret(headers[settings.webhookHeader], secret);
  const given = headers[settings.webhookSignatureHeader];
  const signature = typeof given === 'string' && sameSecret(given.trim().toLowerCase().replace(/^sha256=/, ''), kitchenWebhookSignature(secret, raw));
  if (settings.webhookCheck === 'shared') return shared;
  if (settings.webhookCheck === 'signature') return signature;
  return shared && signature;
}

export async function kitchenWebhookRoutes(app: FastifyInstance): Promise<void> {
  // The raw text is kept for the signature; JSON is parsed here, after the proof.
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: KITCHEN_WEBHOOK_BODY_LIMIT }, (_request, body, done) => {
    done(null, body);
  });

  app.post<{ Params: { vendorIntegrationId: string } }>('/notifications/:vendorIntegrationId', {
    bodyLimit: KITCHEN_WEBHOOK_BODY_LIMIT,
    config: { rateLimit: { ...KITCHEN_WEBHOOK_RATE, keyGenerator: (request: FastifyRequest) => request.ip } },
  }, async (request, reply) => {
    if (!dragontailIntegrationEnabled()) return reply.code(404).send({ status: 'faild', errDescription: 'not found' });
    const id = request.params.vendorIntegrationId;
    if (!/^[a-z0-9]{8,40}$/i.test(id)) return reply.code(404).send({ status: 'faild', errDescription: 'not found' });
    // Pre-auth, so no tenant yet: the connection names its own tenant (as a QR short code does).
    const integration = await runAsSystem('kitchen-webhook', () => app.prisma.vendorIntegration.findUnique({ where: { id } }));
    if (!integration || !integration.enabled || integration.provider !== 'DRAGONTAIL') {
      return reply.code(404).send({ status: 'faild', errDescription: 'not found' });
    }
    // Only this connection's own derived reference: never another store's secret.
    const secret = kitchenWebhookSecretFor(integration);
    if (!secret) {
      log().error({ vendorIntegrationId: id }, '[KITCHEN] webhook arrived but the connection has no webhook secret; nothing recorded');
      return reply.code(503).send({ status: 'error', errDescription: 'not configured' });
    }
    const raw = typeof request.body === 'string' ? request.body : '';
    if (!kitchenWebhookAuthentic(request.headers as Record<string, unknown>, raw, secret, dragontailSettings())) {
      log().warn({ vendorIntegrationId: id }, '[KITCHEN] webhook refused: missing or wrong proof');
      return reply.code(403).send({ status: 'error', errDescription: 'forbidden' });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ time: dragontailTime(new Date()), status: 'error', rowCount: 0, errNum: 1, errDescription: 'Invalid data received' });
    }
    const events = dragontailEvents(body);
    const outcomes = await runWithTenant(integration.tenantId, async () => {
      const applied = await applyKitchenEvents({ prisma: app.prisma, io: app.io, redis: app.redis }, integration, events);
      await app.prisma.vendorIntegration.update({ where: { id }, data: { lastHealthyAt: new Date() } }).catch(() => undefined);
      return applied;
    });
    return { time: dragontailTime(new Date()), status: 'ok', rowCount: outcomes.length };
  });
}
