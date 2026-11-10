// ---------------------------------------------------------------------------
// [CARD-STAGING-TEST 10 Nov 2026] What PowerTranz's REAL staging sandbox sent
// and answered, redacted: every field name, nesting, type and order is the
// real one; every identifier, token, code, name, address and card digit is
// replaced by a synthetic value of the same shape. Nothing here identifies a
// card, a person or a real transaction. Amounts, currency, ISO codes, dates
// and counts are the real ones (a GY$15,000 weekly-fee test payment).
// ---------------------------------------------------------------------------

export const STAGING_TXN = '4f1c2b3a-0d9e-4c8b-a7f6-5e4d3c2b1a09';
export const STAGING_ORDER = 'SWIFT-cmstagingshape0000000000';
export const STAGING_AMOUNT_MINOR = 1_500_000; // GY$15,000.00 (GYD has 2 decimals in Swift's minor units)
/** The card's last digits in the post (synthetic, distinctive). */
export const STAGING_CARD_SUFFIX = '8317';

/** The browser's return to MerchantResponseUrl: x-www-form-urlencoded, exactly these three fields in this order. */
export function stagingReturnPost(o: { txn?: string; order?: string; spiToken: string; status?: string; eci?: string; responseCode?: string; outerTxn?: string; outerSpiToken?: string }) {
  const txn = o.txn ?? STAGING_TXN;
  const response = {
    TransactionType: 2,
    Approved: false,
    TransactionIdentifier: txn,
    TotalAmount: 15000,
    CurrencyCode: '328',
    CardBrand: 'Visa',
    CardSuffix: STAGING_CARD_SUFFIX,
    IsoResponseCode: o.responseCode ?? '3D0',
    ResponseMessage: '3D-Secure complete',
    RiskManagement: {
      ThreeDSecure: {
        Eci: o.eci ?? '05',
        Cavv: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        Xid: '00000000-0000-4000-8000-000000000001',
        AuthenticationStatus: o.status ?? 'Y',
        ProtocolVersion: '2.1.0',
        FingerprintIndicator: 'U',
        DsTransId: '00000000-0000-4000-8000-000000000002',
        ResponseCode: o.responseCode ?? '3D0',
        CardholderInfo: 'SYNTHETIC-CARDHOLDER-INFO: please contact your issuer at 000-000-0000 about this purchase.',
      },
    },
    PanToken: 'SYNTHETIC-PAN-TOKEN-00000000000000000000000000000000',
    OrderIdentifier: o.order ?? STAGING_ORDER,
    SpiToken: o.spiToken,
    BillingAddress: { FirstName: 'Testa', LastName: 'Quillfeather', CountryCode: '328', EmailAddress: 'cardholder@example.test' },
  };
  return { Response: JSON.stringify(response), TransactionIdentifier: o.outerTxn ?? txn, SpiToken: o.outerSpiToken ?? o.spiToken };
}

/** The values in the return post that must never be stored, logged or echoed (the card's last digits: leaksCardSuffix). */
export const STAGING_RETURN_SECRETS = [
  'SYNTHETIC-PAN-TOKEN-00000000000000000000000000000000',
  'SYNTHETIC-CARDHOLDER-INFO',
  'cardholder@example.test',
  'Testa',
  'Quillfeather', // [REVIEW-2466-A F2] the cardholder's last name: distinctive, so it can only come from the post
  'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
] as const;

/**
 * [REVIEW-2466-A F2] The card's last digits as the post carries them (CardSuffix). Four digits can occur by chance
 * inside a random digest, id or token, so a leak is the value standing on its own: a token of its own (not inside a
 * longer run of letters and digits), quoted or not.
 */
export function leaksCardSuffix(text: string): boolean {
  return new RegExp(`(^|[^0-9A-Za-z])${STAGING_CARD_SUFFIX}([^0-9A-Za-z]|$)`).test(text);
}

const summaryOf = (fields: Record<string, unknown>) => ({
  CaptureCount: 0, CreditCount: 0, OriginalTrxnDateTime: '0001-01-01T00:00:00', SettledAmount: 0, TotalCaptureAmount: 0, TotalCreditAmount: 0, ...fields,
});

/** GET /api/Transactions/{id} for a page only preprocessed (SP4): no Approved, no order, no void. */
export function stagingPreprocessedRecord(txn = STAGING_TXN) {
  return {
    CurrencyCode: '328', IsoResponseCode: 'SP4', OrderSummary: summaryOf({}), OtherAmount: 0, ResponseMessage: 'SPI Preprocessing complete',
    TaxAmount: 0, TipAmount: 0, TotalAmount: 15000, TransactionDateTime: '2026-11-10T00:34:44.993', TransactionIdentifier: txn, TransactionType: 2,
  };
}

/** ... for a page whose 3-D Secure passed but was never completed (3D0). */
export function stagingAuthenticatedRecord(txn = STAGING_TXN) {
  return { ...stagingPreprocessedRecord(txn), IsoResponseCode: '3D0', ResponseMessage: '3D-Secure complete', TransactionDateTime: '2026-11-10T00:59:07.723' };
}

/**
 * ... for an approved, captured Sale. `voidDateTime`: as the real record after Swift voided it the same day (set in
 * OrderSummary only; IsoResponseCode stays "00", the capture stays 15000, no credit).
 */
export function stagingSaleRecord(o: { txn?: string; order?: string; voidDateTime?: string; summary?: Record<string, unknown>; top?: Record<string, unknown> } = {}) {
  const txn = o.txn ?? STAGING_TXN;
  return {
    AuthorizationCode: '000000',
    CurrencyCode: '328',
    IsoResponseCode: '00',
    OrderSummary: {
      CaptureCount: 1,
      CreditCount: 0,
      CurrencyCode: '328',
      LastCaptureDateTime: '2026-11-10T01:03:11.55',
      OrderIdentifier: o.order ?? STAGING_ORDER,
      OriginalTrxnDateTime: '2026-11-10T01:03:11.55',
      OriginalTrxnIdentifier: txn,
      SettledAmount: 0,
      TotalCaptureAmount: 15000,
      TotalCreditAmount: 0,
      ...(o.voidDateTime !== undefined ? { VoidDateTime: o.voidDateTime } : {}),
      ...o.summary,
    },
    OtherAmount: 0,
    ResponseMessage: 'Transaction is approved',
    Rrn: '000000000000',
    TaxAmount: 0,
    TipAmount: 0,
    TotalAmount: 15000,
    TransactionDateTime: '2026-11-10T01:02:46.843',
    TransactionIdentifier: txn,
    TransactionType: 2,
    ...o.top,
  };
}

/** The real void's VoidDateTime (no zone; UTC-4: 05:03:11.773Z), and the instant it names. */
export const STAGING_VOID_DATE_TIME = '2026-11-10T01:03:11.773';
export const STAGING_VOID_AT_MS = Date.UTC(2026, 10, 10, 5, 3, 11, 773);
/** When the real records were read (05:04:40Z), and when the session began (shortly before the sale). */
export const STAGING_READ_AT_MS = Date.UTC(2026, 10, 10, 5, 4, 40, 378);
export const STAGING_SESSION_AT_MS = Date.UTC(2026, 10, 10, 5, 2, 46, 201);

/**
 * ... for a VOID: PowerTranz's own transaction (TransactionType 4) with its own id, whose record also reads "00", a
 * capture of 15000, no credit, a VoidDateTime, the order — and OriginalTrxnIdentifier naming the sale it voided.
 */
export const STAGING_VOID_TXN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
export function stagingVoidRecord(o: { sale?: string; voidTxn?: string; order?: string } = {}) {
  const sale = o.sale ?? STAGING_TXN;
  return {
    ...stagingSaleRecord({ txn: o.voidTxn ?? STAGING_VOID_TXN, order: o.order ?? STAGING_ORDER, voidDateTime: '2026-11-10T01:11:43.59',
      summary: { OriginalTrxnIdentifier: sale, LastCaptureDateTime: '2026-11-10T01:11:43.39', OriginalTrxnDateTime: '2026-11-10T01:11:43.39' } }),
    TransactionDateTime: '2026-11-10T01:11:43.59',
    TransactionType: 4,
  };
}

/** The return post when PowerTranz refuses its own page (page set without PTZ/): the same three fields, and a Response
 *  of IsoResponseCode 12 with Errors 757 "Hosted page not found" — no 3-D Secure block. */
export function stagingPageNotFoundPost(o: { txn: string; order: string; spiToken: string }) {
  const response = {
    TransactionType: 2, Approved: false, TransactionIdentifier: o.txn, IsoResponseCode: '12', ResponseMessage: 'Invalid transaction',
    OrderIdentifier: o.order, Errors: [{ Code: '757', Message: 'Hosted page not found' }],
  };
  return { Response: JSON.stringify(response), TransactionIdentifier: o.txn, SpiToken: o.spiToken };
}

/** What PowerTranz's Conductor answers when the page opens: its card form (field names as seen on staging). */
export const STAGING_HPP_HTML = '<!DOCTYPE html><html><head><title>Swift Weekly Fee</title></head><body><div id="hpp">'
  + '<input type="text" name="CardholderName"><input type="tel" name="CardNo" placeholder="XXXXXXXXXXXXXXXX"><input type="tel" name="CardExpDate">'
  + '<input type="tel" name="CardCVV2"><input type="hidden" name="SpiToken" value="spi-synthetic"><button type="button" id="BtnSubmit">Confirm Payment</button></div></body></html>';

/** ... and what it answers for a page it cannot find: a page that posts the 757 result straight back to MerchantResponseUrl. */
export function stagingConductorNotFoundHtml(returnUrl: string, o: { txn: string; order: string; spiToken: string }) {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const post = stagingPageNotFoundPost(o);
  return `<!DOCTYPE html><html><body><form id="r" name="r" action="${esc(returnUrl)}" method="POST">`
    + Object.entries(post).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('')
    + `</form><script>window.onload=function(){document.getElementById('r').submit();}</script></body></html>`;
}
