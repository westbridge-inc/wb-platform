/**
 * [COMPANY-DOCS PART 2 · owner 10 Nov 2026 ~07:5xZ] The in-app letter of authority's routes (authority-letter.service.ts).
 *
 * authorityLetterVendorRoutes (/api/v1/vendor/authority-letters, signed in): the ACCOUNT HOLDER of a company's store
 * account (or a registered business's manager) asks the director (or the owner) to sign, sees how far it got ("waiting
 * for <first name> to sign"), sends the link again, or withdraws it. Only the account holder: never staff, never another
 * account. The paper letter upload (POST /verification/documents) stays the fallback, unchanged.
 *
 * authorityLetterPublicRoutes (/api/v1/public/authority-letter, no account): the signing page. The link's secret is the
 * only credential and is only ever sent in a POST body (the page reads it after the '#'), so it never reaches a server
 * log; each route is rate-limited by address, and the SMS routes by number too. While the switch is off every one of
 * them is dark (404), checked before the body is read.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from '../../../lib/zod';
import { AppError } from '../../../utils/errors';
import { normalizePhone } from '../../../utils/phone';
import { smsDestinationAllowed } from '../../../utils/sms-budget';
import { AuthorityLetterService, type ParsedForm } from './authority-letter.service';
import { HIDDEN_CHARACTERS, cleanField } from './letter';
import type { LetterBasis } from './letter';
import { authorityLetterEsignEnabled } from './esign-switch';

/** [review F6] The refusal of a hidden character (control, bidi, zero-width, private-use), recognised by parseLetterForm. */
const HIDDEN_REFUSAL = 'HIDDEN_CHARACTERS';
/** A typed field: hidden characters REFUSED (never silently kept), then cleaned (letter.ts cleanField) and measured. */
const text = (min: number, max: number) => z.string().trim().max(400)
  .refine((v) => !HIDDEN_CHARACTERS.test(v), HIDDEN_REFUSAL)
  .transform(cleanField)
  .pipe(z.string().min(min).max(max).refine((v) => !/[<>]/.test(v), 'Use letters, numbers and ordinary punctuation'));

/** Each field in plain words, for the refusal the apps show as the server wrote it. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  businessName: 'the business name', registrationNumber: 'the registration number', requesterName: 'your name',
  requesterRole: 'your position', signerName: 'the signer’s name',
};

/** The form's fields, in the server's own limits (the apps mirror them). */
export const letterFormSchema = z.object({
  businessName: text(2, 120),
  registrationNumber: text(1, 40),
  requesterName: text(3, 80),
  requesterRole: text(2, 60),
  signerName: text(3, 80),
  signerPhone: z.string().trim().max(24),
}).strict();

/** The signer's number in its one stored form, or the form's refusal. */
export function parseLetterForm(body: unknown): ParsedForm {
  const parsed = letterFormSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const hidden = parsed.error.issues.find((i) => i.message === HIDDEN_REFUSAL);
    if (hidden) {
      const field = String(hidden.path[0] ?? '');
      throw new AppError(400, 'LETTER_FIELD_HIDDEN_CHARACTERS', `Remove the hidden characters from ${FIELD_WORDS[field] ?? 'a detail'} (copied text can carry them): type it again.`, { field });
    }
    throw parsed.error;
  }
  const form = parsed.data;
  const signerPhone = normalizePhone(form.signerPhone);
  if (!/^\+[1-9]\d{7,14}$/.test(signerPhone) || !smsDestinationAllowed(signerPhone)) {
    throw new AppError(400, 'SIGNER_PHONE_NOT_VALID', 'Enter a Guyana mobile number the text can reach.');
  }
  return { ...form, signerPhone };
}

/** The account holder (the VendorOwner) and the store they act from; anyone else is refused before the body is read. */
async function accountHolder(app: FastifyInstance, request: FastifyRequest): Promise<{ userId: string; vendorId: string; basis: string }> {
  const userId = request.user.userId;
  const owner = await app.prisma.vendorOwner.findUnique({
    where: { userId },
    select: { accountBasis: true, vendors: { select: { id: true }, orderBy: { createdAt: 'asc' } } },
  });
  if (!owner || owner.vendors.length === 0) {
    throw new AppError(403, 'STAFF_FORBIDDEN', 'Only the person who manages this store account can do this');
  }
  const asked = request.headers['x-vendor-id'];
  const vendorId = typeof asked === 'string' && owner.vendors.some((v) => v.id === asked) ? asked : owner.vendors[0]!.id;
  return { userId, vendorId, basis: owner.accountBasis };
}

/** The switch (esign-switch.ts): while it is off nobody starts or re-sends a letter (the paper upload is the path). */
function assertOn(): void {
  if (!authorityLetterEsignEnabled()) {
    throw new AppError(503, 'AUTHORITY_LETTER_ESIGN_OFF', 'Signing the letter in Swift isn’t available. Upload a signed paper letter instead.');
  }
}

/**
 * [review F3] ...and every public signing route is DARK (404, as if it did not exist), checked before the body is read:
 * a link sent while the switch was on can no longer be opened, texted a code or signed, so nothing more about a signer
 * is collected once the switch is turned off (for example, if the Privacy wording is withdrawn).
 */
function assertSigningOpen(): void {
  if (!authorityLetterEsignEnabled()) {
    throw new AppError(404, 'LETTER_LINK_NOT_VALID', 'This link doesn’t work any more. Ask the person who sent it to use a signed paper letter instead.');
  }
}

const letterBasis = (basis: string): LetterBasis => {
  if (basis === 'COMPANY' || basis === 'MANAGER') return basis;
  throw new AppError(409, 'AUTHORITY_LETTER_NOT_NEEDED', 'Your account does not need a letter of authority.');
};

export async function authorityLetterVendorRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const service = new AuthorityLetterService(app);
  const idParam = z.object({ id: z.string().min(1).max(64) });


  /** GET / — the account's newest request (null when none), with what the Documents page shows, and whether the form is offered. */
  app.get('/', auth, async (request) => {
    const holder = await accountHolder(app, request);
    return { success: true, data: { enabled: authorityLetterEsignEnabled(), accountBasis: holder.basis, request: await service.current(holder.userId) } };
  });

  /** POST / — write the letter and text the director (or the owner) the link. */
  app.post('/', { ...auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const holder = await accountHolder(app, request);
    const basis = letterBasis(holder.basis);
    assertOn();
    const form = parseLetterForm(request.body);
    const view = await service.create({ userId: holder.userId, vendorId: holder.vendorId, basis, form, ip: request.ip });
    reply.code(201);
    return { success: true, data: { request: view } };
  });

  /** POST /:id/resend — a new link (the old one stops working). */
  app.post('/:id/resend', { ...auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const holder = await accountHolder(app, request);
    const { id } = idParam.parse(request.params);
    assertOn();
    return { success: true, data: { request: await service.resend(holder.userId, id) } };
  });

  /** POST /:id/cancel — withdraw it (for example, a wrong number). */
  app.post('/:id/cancel', auth, async (request) => {
    const holder = await accountHolder(app, request);
    const { id } = idParam.parse(request.params);
    return { success: true, data: { request: await service.cancel(holder.userId, id) } };
  });
}

const tokenField = z.string().trim().min(1).max(64);

export async function authorityLetterPublicRoutes(app: FastifyInstance) {
  const service = new AuthorityLetterService(app);

  /** POST /open { token } — the letter to read (exactly the words that will be signed). */
  app.post('/open', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    assertSigningOpen();
    const { token } = z.object({ token: tokenField }).strict().parse(request.body ?? {});
    return { success: true, data: await service.open(token) };
  });

  /** POST /code { token } — text a code to the signer's number. */
  app.post('/code', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    assertSigningOpen();
    const { token } = z.object({ token: tokenField }).strict().parse(request.body ?? {});
    return { success: true, data: await service.sendCode(token) };
  });

  /** POST /verify { token, code } — the code is right: a short-lived signing key. */
  app.post('/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    assertSigningOpen();
    const { token, code } = z.object({ token: tokenField, code: z.string().trim().max(12) }).strict().parse(request.body ?? {});
    return { success: true, data: await service.verifyCode(token, code) };
  });

  /** POST /sign { token, signingKey, signature, agree: true } — sign and file the letter. */
  app.post('/sign', { bodyLimit: 700_000, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    assertSigningOpen();
    const body = z.object({
      token: tokenField, signingKey: z.string().trim().min(1).max(64), signature: z.string().min(1).max(600_000), agree: z.literal(true),
    }).strict().parse(request.body ?? {});
    const ua = request.headers['user-agent'];
    const result = await service.sign({
      token: body.token, signingKey: body.signingKey, signature: body.signature, ip: request.ip,
      userAgent: typeof ua === 'string' ? ua : null, log: request.log,
    });
    reply.code(201);
    return { success: true, data: result };
  });
}
