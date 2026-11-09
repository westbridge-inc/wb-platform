# Card payments for the weekly fee: the API contract

This is the contract the phone app and the web build the Swift card screens against. It mirrors `MMG-CHECKOUT-API.md`: the same route families, headers, error envelope and rules. The API side ships as:
- **PT-1 (#1375):** the card rail foundation. Hosted sessions, bound cards, the simulator, and the weekly charge on an enrolled card.
- **PT-2 (this contract's PR):** the routes below and `cardPayAction`.
- **PT-4:** the PowerTranz provider, built from PowerTranz's own Ecommerce API Guide v2.7.

Until PT-2 is merged, these routes do not exist.

Until PT-4 is merged **and** the card provider is configured, `CARD` is `off` in `payActions`: hidden, and the app shows no card button at all.

The provider's name is never shown to a partner: the screens say "card", "Visa" or "Mastercard", and "your bank".

## 0. Rules every client follows

1. **The server decides everything:**
   - whether card payment exists (`payActions`);
   - what a Pay now costs (the server prices it; a client amount is never read);
   - whether a card was added or a payment happened.

   Only the card provider's own server-to-server answer decides the last one. A redirect, a return page, the browser or the app's word never does.
2. **No card number, security code or PIN ever reaches Swift.** Not Swift's servers, and not any Swift field in the app or the web.
   - The card is typed only on the provider's hosted page.
   - Swift's screen hosts that page (an in-app sheet in the app, a page on the web) and styles everything around it.
   - Never build a card form.
3. **A card is shown as brand, last 4, expiry and status**, and nothing else. There is nothing else to show.
4. **Hidden, never teased.** `CARD` in state `off` is not shown at all: no disabled button, no "coming soon".
5. **Money is never taken from a removed card.** Remove is immediate. A charge that was already on its way before the removal is still reconciled, and never repeated.

## 1. Route families

| Partner | Family | Who may call |
|---|---|---|
| Store owner (restaurant, supermarket, store) and service provider | `/api/v1/vendor` | the store's OWNER; `x-vendor-id` selects the store |
| Delivery rider and courier | `/api/v1/rider` | the rider |
| Taxi driver | `/api/v1/driver` | the driver |

Below, `{family}` means one of `vendor`, `rider` or `driver`. The same routes and shapes apply to all three.

## 2. Headers

| Header | Where | Value |
|---|---|---|
| `Authorization` | every partner route | `Bearer <access token>` (or the web session, as in `MMG-CHECKOUT-API.md` section 2) |
| `x-client-platform` | every partner route below (**required**) | `ios`, `android` or `web` |
| `x-vendor-id` | vendor routes | the selected store's id |
| `Idempotency-Key` | `POST …/card-sessions` only | 8–128 characters from `[A-Za-z0-9_-]`, new per tap; reuse it for a retry of the same tap |

## 3. `payActions`: the `CARD` entry

`GET /api/v1/{family}/subscription` carries `payActions` (see `MMG-CHECKOUT-API.md` section 3). Its `CARD` entry is:

```ts
type CardPayAction =
  | { id: 'CARD'; state: 'off' }
  | {
      id: 'CARD';
      state: 'live';
      payNow: { amount: number; currencyCode: string };  // exactly what a Pay-now session charges right now
      addCard: boolean;                                   // may the partner save a card for the weekly fee?
      cardOnFile: CardView | null;                        // the ACTIVE card, if any
      testMode: boolean;                                  // a test card choice (see "Testing" below): show testModeLabel
      testModeLabel?: string;
    };
```

`CARD` is `live` only when **all** of these hold:
- card payments are switched on on the server (`CARD_RAIL_V2=1`) and not paused (`CARD_RAIL_KILL`);
- the server's card provider is the real one with a complete configuration (PT-4). The simulator makes `CARD` live only on a test server switched to show it (`CARD_RAIL_SIMULATOR_LIVE=1`; production refuses to start with it), and then with `testMode: true`;
- the per-platform switch allows the caller's platform (section 9);
- the subscription can be paid: `TRIAL`, `ACTIVE`, `PAST_DUE`, `SUSPENDED` or `CHURNED`, not waived, with a fee above zero;
- the partner is a real partner (the store-review demo never sees a card button);
- no payment of this fee is being confirmed (an MMG checkout or a card page still open or unclear), and the billing clock covers the subscription: the same rule as `MMG_CHECKOUT`.

Otherwise it is `off`. Reading the subscription never fails because of the card rail: if the server cannot decide, `CARD` is `off`.

**`addCard`** is `true` only when the server's provider can charge a saved card each week without the partner present **and** saving cards is switched on (`CARD_RAIL_ENROLL=1`, off until the owner signs off the consent words). The real provider's guide documents no such charge, so it is `false` (section 11). When `addCard` is `false`:
- the app shows **Pay now by card** only: no Add card, no saved-card screens;
- `cardOnFile` is `null`;
- an Add card session is refused with `409 ADD_CARD_OFF` (section 5).

**Testing before PowerTranz.** On a staging server that runs the card simulator (`CARD_RAIL_V2=1`, `CARD_RAIL_PROVIDER=simulator`), the routes in sections 4 to 7 work and answer `testMode: true`. The simulator moves no money, yet its "Approve" books a paid week, so it — like any card TEST system, including the provider's sandbox — serves **only the test subscriptions listed by id** in `CARD_RAIL_TEST_SUBSCRIPTIONS`; for every other partner the card routes answer `409 PAY_ACTION_OFF` and `CARD` is `off`. It never runs on the public API host (the server refuses to start). `payActions` shows `CARD` as `off` even for a listed test subscription unless the server also sets `CARD_RAIL_SIMULATOR_LIVE=1`: then `CARD` is `live` with `testMode: true` and `testModeLabel`, so a normal build shows the whole card choice end to end. Every screen must show `testModeLabel` whenever `testMode` is true. The store-review demo never sees a card choice, test or real.

**`payNow`** buttons read `Pay <currency> <amount, grouped> by card`.
- When a week is owed, the amount is that week.
- When nothing is due, it is the next week (four weeks ahead at most, owner 6 Nov 2026). A payment for a week that has not started when the provider's answer is booked is kept as fee credit (settlement `banked`), exactly like money paid ahead through MMG: the next fee date does not move, the credit pays that week when it starts, and at closing it is refunded like every week that has not started (`PAY-AHEAD-AND-REFUNDS.md` section 5). A week that began while the bank was confirming is paid at once (settlement `advanced`).

## 4. Cards

**`GET /api/v1/{family}/subscription`** also carries **`latestCardSession`**: the partner's newest card session of the last 24 hours as a `CardSessionView` (section 6; never its page address), or `null`.

**`GET /api/v1/{family}/subscription/cards`** returns every card the subscription ever had, newest first, and the same `CARD` entry as `payActions`:

```ts
{ success: true, data: { cards: CardView[]; payAction: CardPayAction } }

type CardView = {
  id: string;
  brand: string;        // e.g. 'VISA'; the simulator says 'SIMULATED'
  last4: string;        // '4242'
  expMonth: number;     // 1–12
  expYear: number;      // 2031
  status: 'ACTIVE' | 'REPLACED' | 'EXPIRED' | 'REVOKED';
};
```

At most one card is `ACTIVE`: the weekly fee is charged to it.

**`DELETE /api/v1/{family}/subscription/cards/{cardId}`** removes a card.
- It needs a fresh step-up (the same confirmation as changing the billing method): without one the answer is `403 STEP_UP_REQUIRED`, whose `details.stepUp` names the two calls. The phone and the web use the same ones: `POST /api/v1/auth/step-up` texts a code to the phone on the account, `POST /api/v1/auth/step-up/verify` with `{ code }` confirms it for ten minutes on this session; then repeat the removal.
- The card becomes `REVOKED` at once and is never charged again.
- Nothing falls back silently: the weekly fee stays due until the partner adds a card or chooses another way to pay.
- The answer is `{ success: true, data: { card: CardView; paymentInProgress: boolean } }`. `paymentInProgress: true` means a weekly charge on this card had already been sent to the bank before the removal: it finishes and is checked, and it is never repeated. Say: "A payment already on its way will finish. Nothing more will be charged to this card."
- Removing a card that is already out of service answers the same card, unchanged.

| Status | Code | Meaning |
|---|---|---|
| 403 | `STEP_UP_REQUIRED` | confirm it is you first |
| 403 | `REVIEW_DEMO_NO_MONEY` | the store-review demo: no money moves there |
| 404 | `CARD_NOT_FOUND` | unknown card, or not this partner's |

## 5. Start a card session (add a card, or pay now)

`POST /api/v1/{family}/subscription/card-sessions`

```ts
// body
{ purpose: 'ENROLL' | 'PAY_NOW'; consentVersion?: 'card-on-file-v1' }  // consentVersion is required for ENROLL
```

- **ENROLL (Add card)** needs the partner to accept the weekly-charge consent on screen first. Send the version they accepted: `card-on-file-v1`, whose words (owner sign-off, 7 Oct 2026) are exactly:

  > Swift will charge the card you add for your weekly fee each week, when it is due, until you remove it. Your bank may ask you to confirm a charge. You can remove the card here at any time.

  New words are a new version, never an edit of this one. Saving cards stays off on the server (`CARD_RAIL_ENROLL`) until the owner's go.
- **PAY_NOW** is priced by the server. The body carries no amount.

**Success:** `201` for a new session; `200` when the same `Idempotency-Key` asks again. A repeat answers the same session **with its `hostedUrl` while the page can still be used** (open and inside its window), so "Continue on the card page" opens it again; once the page is finished or expired, `hostedUrl` is `null`.

```ts
{ success: true, data: CardSession }

type CardSession = {
  sessionId: string;
  purpose: 'ENROLL' | 'PAY_NOW';
  status: 'OPEN';
  hostedUrl: string;     // open it in the in-app sheet (phone) or the same tab (web); never log, store or share it
  expiresAt: string;     // ISO time; the page cannot be used after it (15 minutes)
  amount?: number;       // PAY_NOW only: what the server priced
  currencyCode?: string; // PAY_NOW only
  testMode: boolean;     // true on the simulator
  testModeLabel?: string; // show it prominently when testMode is true
};
```

**One live session per purpose.** An Add card may run beside a Pay now, but never two of the same.

| Status | Code | Meaning | What the client does |
|---|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | the header is missing or malformed | send a key |
| 400 | `INVALID_CARD_SESSION` | the body is not exactly `{ purpose, consentVersion? }` (an amount, or anything else, is refused) | fix the client |
| 400 | `CARD_CONSENT_REQUIRED` | ENROLL without the accepted consent version | show the consent |
| 401 / 403 | (existing auth codes) | not signed in, or not this store's owner | the usual |
| 403 | `REVIEW_DEMO_NO_MONEY` | the store-review demo: no money moves there | show its message |
| 404 | `SUBSCRIPTION_NOT_FOUND` | no subscription | refetch |
| 409 | `PAY_ACTION_OFF` | card payment is not available here: switched off on the server, no provider, the platform switched off, or the subscription cannot pay | refetch the subscription; hide card |
| 409 | `ADD_CARD_OFF` | ENROLL, but saving a card is not available (`addCard: false`) | offer Pay now by card |
| 409 | `CARD_SESSION_OPEN` | a page for this purpose is already open | wait, or finish it there |
| 409 | `PAYMENT_CONFIRMING` | a payment of this fee is still being confirmed | "We're checking a payment. Don't pay again." Refetch later |
| 409 | `MOVER_FEE_PRICE_CHANGED` | the weekly fee changed while the page was being opened | refetch, then try again |
| 409 | `MOVER_FEE_REVIEW_REQUIRED` | the fee needs a person's review before another payment | "Support will contact you." |
| 409 | `NOTHING_TO_PAY` | PAY_NOW with no fee | refetch |
| 409 | `SUBSCRIPTION_CLOSED` | the subscription has ended | refetch |
| 429 | `RATE_LIMITED` | too many attempts | wait and retry |
| 502 | `CARD_SESSION_UNAVAILABLE` | the provider could not open a page | "Try again in a moment." |
| 503 | `CARD_RAIL_DISABLED` | card payments are paused (the kill switch) | "Please use another way to pay." |

The error body is always `{ success: false, error: { code, message, details? } }`.

**The phone flow:**

```
POST …/card-sessions                      → { sessionId, hostedUrl }
open hostedUrl in the in-app sheet (WebBrowser.openAuthSessionAsync(hostedUrl, 'swift://pay/card/return'))
// whatever the sheet returns (done, cancel, dismiss):
poll GET …/card-sessions/{sessionId}      → section 6
```

**The web flow:** open `hostedUrl` in the same tab. The page sends the partner back to the return page (section 7), which links to the dashboard.

## 6. Follow a session

`GET /api/v1/{family}/subscription/card-sessions/{sessionId}`

```ts
{ success: true, data: CardSessionView }

type CardSessionView = {
  sessionId: string;
  purpose: 'ENROLL' | 'PAY_NOW';
  status: 'OPEN' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'CANCELLED' | 'HELD';
  expiresAt: string;
  amount?: number;                        // PAY_NOW
  currencyCode?: string;                  // PAY_NOW
  card?: CardView;                        // ENROLL that SUCCEEDED
  settlement?: 'advanced' | 'banked';     // PAY_NOW that SUCCEEDED
  failure?: 'DECLINED' | 'NOT_AUTHENTICATED' | 'CARD_EXPIRED' | 'NOT_FINISHED' | 'PAGE_UNAVAILABLE'; // FAILED, EXPIRED or CANCELLED: why
  subscriptionStatus: string;             // the subscription now, so the screen updates in place
  testMode: boolean;
  testModeLabel?: string;                 // when testMode is true
};
```

`404 CARD_SESSION_NOT_FOUND` is the one answer for an unknown session and for another partner's.

**Polling:**
- After the sheet closes, poll every 3 s for 1 minute, then every 15 s for 10 minutes, then stop.
- Stop early at `SUCCEEDED`, `FAILED`, `CANCELLED` or `HELD`.
- `UNKNOWN` and `EXPIRED` after a Pay now are not final for money: the server keeps asking the provider, and a late capture is booked once. Refresh quietly when the screen gains focus.

| Status | Meaning | The app may say |
|---|---|---|
| `OPEN` | the partner has not finished on the page, or the provider has not answered yet | "Finish on the card page." After returning: "Checking with the bank…" |
| `UNKNOWN` | the provider has not answered; Swift keeps asking (Pay now only) | "Checking with the bank. Don't pay again." |
| `SUCCEEDED` | ENROLL: the card is saved. PAY_NOW: the provider took the payment and it is booked | ENROLL: "Card added: VISA ending 4242." PAY_NOW, `advanced`: "Paid: <amount> received." PAY_NOW, `banked`: "Payment received. It is kept for your next weekly fee." (owner ruling 8 Oct: never "wallet", "top up" or "balance"; owner #62, kept after 6 Nov 2026: never "paid ahead") |
| `FAILED` | the bank declined, or the card has expired | "The card was not added." / "The payment didn't go through. You can try again." |
| `EXPIRED` | the page ran out of time with nothing done | "This page expired. You can start again." |
| `CANCELLED` | the provider could not open the page | "Try again in a moment." |
| `HELD` | the provider's answer does not match (amount, currency or wallet), or the bank may have taken a payment Swift could not confirm and its cancellation could not be confirmed either; a person reviews it | "We're checking this payment by hand. Don't pay again. Support will contact you." |

Never say "paid" or "added" before `SUCCEEDED`.

**`failure`** (plain categories, never the bank's or the provider's own words): `DECLINED` "Your bank declined the card." · `NOT_AUTHENTICATED` "Your bank's check (3-D Secure) didn't go through. Nothing was charged." · `CARD_EXPIRED` "This card has expired." · `NOT_FINISHED` "The card page wasn't finished. Nothing was charged." · `PAGE_UNAVAILABLE` "The card page couldn't open. Try again in a moment."

## 7. The return page (public)

The provider sends the partner's browser back to Swift's return address, `/api/v1/billing/card/return?session=<id>&state=<one-time value>`. It is the provider's `MerchantResponseUrl`. The app and the web never call it themselves.

- **It accepts GET and POST.** Query parameters and form, JSON or JSON-as-text fields, up to 16 KB. (The real provider's card frame posts the bank's 3-D Secure result here "as Json", which a form sends as text.)
- **It records what came back and grants nothing by itself.**
  - Only the first return that carries the session's one-time `state`, while the session is open and inside its window, prompts the server to ask the provider, server to server.
  - Everything else (a wrong or reused `state`, a closed or expired session, an unknown session) is recorded with its reason and ends there.
  - The browser usually arrives without the partner's Swift session (it is a cross-site redirect from the provider), so the return never depends on who is signed in.
- **It answers a small HTML page:**

  | State | Page text |
  |---|---|
  | `SUCCEEDED` | "Done. Go back to the Swift app to see it." |
  | `PENDING` | "We're checking with the bank. Don't pay again. You can close this page." |
  | `FAILED` | "This didn't go through. You can try again in the Swift app." |
  | `UNKNOWN` | "Open the Swift app to see your weekly fee." |

  The page carries no amount, name, card or id: anyone who holds the link would see it.
- **Every state shows two ways back, as Swift's buttons** (links styled as the app's pill buttons):
  - "Back to the Swift app" → `swift://pay/card/return`, with no parameters;
  - "Continue on the web" → the web's neutral weekly-fee route, `<APP_PUBLIC_URL>/weekly-fee` (the same route as the MMG return page), which picks the dashboard or the portal from the signed-in session.
- **It waits at most 20 seconds for the provider's answer.** Past that it shows `PENDING`; the answer is still recorded when it comes, and the sweep asks again if it never does.
- **It is never logged or cached.** Swift never writes its query or body to a log line. It sends `X-Robots-Tag: noindex`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- **It is rate-limited per source address** (60 a minute), whoever is signed in: rotating sign-ins from one address buys nothing.
- **It is inert while card payments are off** (`CARD_RAIL_V2=0` and not draining): nothing is read or written, and the page says `UNKNOWN`.

**The real provider (PT-4)** — `hostedUrl` is a Swift page on the API origin, `/api/v1/billing/card/pay/{ref}`:
- Swift's header and words ("Pay GY$2,100 by card", "Type your card on your bank's secure form below. Swift never sees your card number or security code.") around an iframe holding the bank's secure card form; the provider's name is never shown.
- On the provider's test system it carries the test label (`testMode: true`, `testModeLabel`), as the CARD entry and the session do.
- The card is typed and the bank's 3-D Secure check runs inside the iframe. When the check is done, the return page above appears inside the same frame with the same two links ("Back to the Swift app" closes the in-app sheet).
- Once the page is finished or expired it shows "This card page has ended" and no form. It sends its own strict content policy, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and is never logged.

**How these pages look** (`card-page-look.ts`, owner 27 Oct 2026: "make it look like the rest of Swift"). The card page, its ended and missing states, the return page and the simulator wear the Swift app's look, read from `packages/ui`: the app's paper and ink, Indian Red, the kit's pill buttons ("Back to the Swift app" primary; "Continue on the web" and, under the bank's frame, "Go back to the Swift app" soft: never "Cancel", since the frame may already say "Done"), its tone chips (the return states use the app's tones: Done success, Checking waiting, didn't go through error, otherwise neutral; the unknown state is headed "Weekly fee", as the MMG return page is) and the Swift mark. They are light only, like the app and the web. Every style is in the page's one inline stylesheet and the mark and icons are inline shapes: nothing is loaded from anywhere, and no page policy changed for the look. The bank's frame is untouched: the card is typed only in it.
- Nothing about opening it changes for the app: open `hostedUrl` in the in-app sheet (phone) or the same tab (web), then poll the session.

**The simulator** (staging only; production refuses it) serves its page at `hostedUrl`:
- four buttons: Approve / Approve, but weekly charges need 3-D Secure / Decline / Time out;
- no input of any kind;
- a TEST PAGE label.

Pressing a button sends the browser to the return page, exactly as a real provider would.

## 8. Admin

| Route | Returns |
|---|---|
| `GET /api/v1/admin/billing/card-sessions?status=&purpose=&subscriptionId=&limit=&before=&refund=` | card sessions, newest first (`limit` 1 to 200, default 50); `status=HELD` is the review queue; `refund=UNCONFIRMED` lists only payments with a refund whose answer is not known. `next` is the id to pass as `before` for the older sessions, or `null` when there are none. Each session carries `cardRefund` (its refund of set-aside credit to the card: `state`, `providerRefundRef`, or `null`) and `providerCheck` (true when "Check with the card provider" applies now) |
| `GET /api/v1/admin/billing/card-sessions/{id}` | one session and its evidence: every observation's source, parsed status, verdict and raw-payload SHA-256 |
| `GET /api/v1/admin/billing/subscriptions/{subscriptionId}/cards` | the subscription's cards: brand, last 4, expiry, status, the provider setup it is bound to, consent, and how it left service |

| `POST /api/v1/admin/billing/card-sessions/{id}/resolve` | finance's decision on a `HELD` Pay now, after checking the provider's portal (money: a second admin approves) |
| `POST /api/v1/admin/billing/card-sessions/{id}/check-provider` | "Check with the card provider": a refund Swift sent for this payment whose answer is not known, read against the provider's own record (money: a second admin approves). Never sends a refund |

- No view ever returns a vault token, the session's state or hash, a provider page address, or anything else that could move money. Views show the provider's transaction reference (what finance looks up) and the session's void, refund, booking-claim and resolution markers.
- **Resolve** body: `{ action, providerReference, amount }`. `providerReference` must be the transaction recorded on the session; the console asks the person to type it as the provider shows it, never fills it in. `amount` is what the person saw taken: `BOOK` and `REFUND` need it; `NOTHING_TAKEN` states none (any amount sent is ignored). `action`:
  - `BOOK` requires the stored provider-approved completion, including its own `RiskManagement.ThreeDSecure` proof, bound to this session and exact price; typed portal facts and two-person approval cannot replace that proof. Missing proof returns `409 PROVIDER_COMPLETION_EVIDENCE_REQUIRED`. It books once — never after a void or refund that may have worked, and never on a card test system for a partner who is not a listed test subscription;
  - `REFUND` sends one refund of that transaction (never resent; never once the week is booked). It is always the WHOLE payment at Swift's price: the guide documents no refund smaller than the payment (5.2), so the amount the person types is only their confirmation of what the portal shows; any other figure is refused (`409 REFUND_NOT_WHOLE`, or `409 REFUND_ABOVE_PAYMENT` when the portal shows more taken) and goes to the owner, and a payment held because the provider's figure differs from the price is never refunded here (`409 REFUND_AMOUNT_UNKNOWN`). This is the API refund (guide 5.2 / 7.5), sent through the provider setup that took the payment; a payment of another setup is refused (`409 CARD_PROVIDER_SETUP_CHANGED`) and escalated to the owner;
  - `NOTHING_TAKEN` records that the provider shows nothing taken. Never once a refund was sent for the payment (lost, refused or unrecorded answer: `409 REFUND_SENT`), and never for a payment held because the provider approved another amount or currency than Swift's price (`409 PROVIDER_SAYS_TAKEN`): such a payment stays HELD for the owner, and the console offers no decision for it. The person looks the payment up in the provider's Merchant Portal or reports by its order reference, `SWIFT-<card session id>` (the OrderIdentifier Swift sends, guide 9.2), as well as by the transaction.
  There is no decision that records a refund made by hand in the provider's Merchant Portal: the guide documents only the API refund. Any other action is refused (`400 INVALID_RESOLUTION`). A refund Swift sent whose answer was lost or is pending stays held until it is checked with the card provider (below).
  Each decision is taken once, under the session's lock; a booking and a refund can never both happen. The general payment-confirmation review refuses to close such a card payment as unpaid (`409 CARD_SESSION_RESOLVE_REQUIRED`).
- **A payment Swift cannot book** (the provider's answer lacks its own 3-D Secure proof, names another transaction, order, type or amount, or was lost) is voided at once — one void, durably claimed. Voided: the session is `FAILED` (no `failure` category). The void refused or unanswered: `HELD`, and admins are paged with the provider's transaction reference.
- **The completion is claimed on the session first.** Immediately before Swift sends the one completion, it records the claim on the session (under the same locks finance takes). A session closed before that moment never has its completion sent (nothing was taken). A claimed completion is never sent twice.
  - While a claimed completion may still be answering (its own deadline plus a margin, 35 s), nobody treats its answer as lost, and the general payment-confirmation review refuses to close it as unpaid (`409 CARD_COMPLETION_IN_FLIGHT`); afterwards it refuses with `409 CARD_SESSION_RESOLVE_REQUIRED` (the session is voided, or held for the card-session decision above).
  - A claimed completion whose answer can no longer arrive (lost) is voided under the recorded transaction, like any payment Swift cannot book — after the transaction lookup below.
- **A completion whose outcome is not known is looked up first** (PowerTranz's written answer to Swift, 4 Nov 2026: `GET <root>/api/Transactions/{TransactionIdentifier}` with the `PowerTranz-PowerTranzId` / `-PowerTranzPassword` headers, only when an outcome is unknown — a timeout, an interruption — never as the normal flow). "Not known" means: the completion was durably claimed, and its answer is lost (past the 35 s deadline) or came back without saying what happened (no answer, unreadable, a server error, a code that is not the bank's answer, a possible duplicate, no `Approved` flag). An answer that did say (a decline; an approval without its proof, for another amount or transaction) is never looked up. The completion is never sent again.
  - **Booked** only when the record confirms an approved sale (`Approved` true, `IsoResponseCode` `00`, `TransactionType` 2) of THIS `TransactionIdentifier` and order (`SWIFT-<card session id>`), in Swift's currency, `OrderSummary.TotalCaptureAmount` equal to Swift's price to the minor unit, no `VoidDateTime` and `TotalCreditAmount` 0, **and** the session already holds the provider's approved completion with its own `RiskManagement.ThreeDSecure` proof (the same rule as `BOOK`; the record is not documented to carry that proof). It books once, through the same checks as any booking.
  - **Voided or refunded in full on the record** (`VoidDateTime` a real date between the session's start and the read, each widened by a day for the unnamed time zone; or `TotalCreditAmount` equal to `TotalCaptureAmount`): `HELD` with `failure` code `LOOKUP_SHOWS_REVERSED`, nothing booked, no void sent. Finance may only record `NOTHING_TAKEN` (two people); `BOOK` and `REFUND` are refused (`409 PROVIDER_SAYS_REVERSED`), and the console offers only "Nothing was taken".
  - **Refunded in part** (a credit smaller than the capture): the rest is still taken. `HELD` with `LOOKUP_PARTIAL_CREDIT`, nothing booked, no void sent, and no decision here: `BOOK`, `REFUND` and `NOTHING_TAKEN` are all refused (`409 PROVIDER_SAYS_PART_REFUNDED`); the console says to check PowerTranz's portal and escalate to the owner. A credit above the capture, or with nothing captured, is unreadable.
  - A `VoidDateTime` that is not such a date (a default like `0001-01-01T00:00:00` or `9999-12-31T23:59:59.9999999`, a date before the payment existed or after the read, a placeholder) makes the record unreadable: it is never taken as a reversal, so the void below is still sent.
  - **The owner's runbook for a hold with no decision here** (`LOOKUP_PARTIAL_CREDIT`, and `AMOUNT_MISMATCH` the same way): the console offers no decision, and while it is held no new card or MMG payment starts for that subscription (`PAYMENT_CONFIRMING`). The owner (1) finds the payment in PowerTranz's Merchant Portal by its transaction and its order `SWIFT-<card session id>`; (2) asks PowerTranz, in writing, to return what is still taken to the same card (or to confirm nothing remains), and keeps their written answer and its reference; (3) asks the coordinator for a reviewed, two-person correction that closes the session and its payment confirmation with that reference. Swift never books it and never records a refund it did not send.
  - **Anything else** — a confirmed sale without the stored proof (COORD ruling 9 Nov 2026), another amount or currency, a decline, no or an unreadable answer (every field is read strictly; anything missing or mistyped is unknown, never success): the path above, unchanged — one void, then `HELD` when the void is not confirmed.
  - **At most one read** per transaction per backoff window (1, 2, 4 … minutes, at most 30), timed by Redis's own clock and shared by every server (its record expires a day after the last read). Inside the window nothing is done to the session; it is asked again by the sweep. The read waits at most 10 s.
  - **Assumed, until PowerTranz confirms** (asked, section 11): the record's top-level `TransactionIdentifier`, `OrderIdentifier`, `TransactionType`, `Approved`, `IsoResponseCode` and `CurrencyCode`, and `OrderSummary` amounts in major units. PowerTranz's answer names only `VoidDateTime` and the `OrderSummary` amounts. A record shaped otherwise reads as unreadable: the path before the lookup, unchanged.
  - **The kill switch does not stop it**: a read moves no money, and booking from it records money the provider already took — the same draining as confirm and the sweep [C7]. It never starts a payment.
- **"Check with the card provider"** (`POST …/card-sessions/{id}/check-provider`, body `{}`; two people). PowerTranz's written answer to Swift (9 Nov 2026): the lookup "is supported for all transaction types", and refunds (partial and Merchant Portal ones included) are supported. For a refund Swift sent whose answer is not known — a `HELD` Pay now's refund (`providerRefundState` `UNKNOWN` or `PENDING`), or a refund of set-aside credit to the card ("Refund to card", `card_credit_refunds` `UNKNOWN` or `PENDING`) — and for a refund claim still `SENDING` ten minutes after it began (its process stopped mid-call; COORD ruling 9 Nov 2026), Swift reads the ORIGINAL transaction's record once (the same read, strict parsing, `VoidDateTime` rules and backoff as above) and answers `check`:
  - `REFUNDED` only when the record shows the WHOLE payment back: `TotalCreditAmount` = `TotalCaptureAmount` = Swift's price to the minor unit on an approved Sale of this transaction, order and currency, or a real `VoidDateTime`. Then the closing paths that already exist run, once: a HELD Pay now is closed `REFUNDED` (`REFUNDED_BY_FINANCE`, its payment confirmation resolved unpaid); a refund to the card becomes `REFUNDED` with its CARD payout part (`PREPAID_REFUND`, `REFUND_PAYABLE` -> `CLEARING_CARD`) on the set-aside it was asked from (`409 REFUND_SET_ASIDE_CHANGED` if that set-aside is no longer open for it: nothing recorded).
  - `OWNER_HOLD`: a credit that is not the whole payment (part of it, or a capture that is not Swift's price). Never recorded as refunded. A HELD payment gets `failure` code `LOOKUP_REFUND_NOT_WHOLE` (no decision: `409 PROVIDER_SAYS_PART_REFUNDED`); admins are paged. It can be checked again after the owner settles it with PowerTranz.
  - `NO_REFUND_ON_RECORD` (no credit, no void yet), `NOT_KNOWN` (no or an unreadable answer), `ASKED_RECENTLY` (inside the backoff window): nothing is recorded.
  - The refund is NEVER sent again: nothing in this path calls the refund or void. Every check is in the admin audit trail with the lookup's verdict.
  - **Assumed, until PowerTranz confirms** (asked, section 11): whether the record lists each refund with its own `TransactionIdentifier` is not known, so Swift reads none. A refund to the card confirmed by the lookup is recorded under Swift's reference `LOOKUP-CREDIT-<original transaction>` (one refund per card payment, ever); the portal shows the refund's own id beside the original.
- **An approval that arrives after its session was closed** is never booked: Swift claims one void, the session becomes `HELD` (`LATE_PROVIDER_APPROVAL`), its payment confirmation is reopened, and admins are paged. The void confirmed: `FAILED` again. Refused or unanswered: it stays `HELD`, `BOOK` is refused, and no new collection of the fee (card or MMG) starts while it is held. A session finance had already decided keeps that decision; admins are paged.


## 9. Operations

- **Settings** (both env templates document them):
  - `CARD_RAIL_V2` (default 0);
  - `CARD_RAIL_V2_DRAIN` (default 0): drain in-flight v2 work after a switch-off;
  - `CARD_RAIL_PROVIDER`: `simulator` off production; `powertranz` with PT-4;
  - `CARD_RAIL_ENVIRONMENT` (`sandbox` | `live`);
  - `CARD_RAIL_ACCOUNT`: a label, never a merchant number;
  - `API_PUBLIC_URL`: where the return page lives;
  - `CARD_RAIL_KILL=1`: stops new sessions and charges, never reconciliation (confirm, the sweep, and the transaction lookup of section 8 keep draining). It is the only switch that kills card rail v2.
  - `PAYMENT_PROVIDER` is the **legacy** card seam (a bare token charged through `providers/payment`), not card rail v2. `disabled` turns off that seam alone: its provider refuses every instruction and billing defers it. It does not stop v2 (until 9 Nov 2026 it did, and a disabled provider required `CARD_RAIL_KILL=1` everywhere).
  - Credentials: card rail v2 reads only `POWERTRANZ_ID`, `POWERTRANZ_PASSWORD` and the optional `POWERTRANZ_GATEWAY_KEY` (and the non-secret `POWERTRANZ_API_URL`, `POWERTRANZ_PAGE_SET`, `POWERTRANZ_PAGE_NAME`). `PAYMENT_GATEWAY_KEY` / `PAYMENT_GATEWAY_SECRET` belong to the legacy seam and stay unset.
  - A test server runs v2 on the provider's sandbox with `PAYMENT_PROVIDER=disabled`, `CARD_RAIL_KILL=0`, `CARD_RAIL_V2=1`, `CARD_RAIL_PROVIDER=powertranz`, `CARD_RAIL_ENVIRONMENT=sandbox` and `CARD_RAIL_TEST_SUBSCRIPTIONS` (only the listed test subscriptions can open a sandbox page). The sandbox shows the card choice as a test by itself; `CARD_RAIL_SIMULATOR_LIVE` is for the simulator only.
  - **Production (launch lock):** the API boot guard and `pilot-up.sh` refuse production unless `PAYMENT_PROVIDER=disabled`, `CARD_RAIL_KILL=1`, and `CARD_RAIL_V2`, `CARD_RAIL_V2_DRAIN`, `CARD_RAIL_ENROLL` are unset or 0. The kill-switch lock is explicit (`assertProductionCardKillSwitch`, also held by the legacy provider factory in production). Turning cards on in production is a reviewed code change to these, never a setting.
- **The per-platform switch** is the card's own platform-config key, `billing.cardCheckout.platforms`: `{ "ios": true, "android": true, "web": true }`. It is separate from MMG's (`billing.feeCheckout.platforms`), so either can be closed alone.
  - iOS is **off** unless the row says `"ios": true` (owner ruling 6 Oct: Apple 3.1.1, iOS off by default).
  - Android and web are on unless the row says `false`.
  - Only a real `true` / `false` counts: any other value switches that platform off, and a row that is not an object switches every platform off (as MMG's switch).
  - A change shows within a minute, with no deploy.
  - An unknown platform counts as on only if every platform is on.

## 10. Notices

- **A weekly charge the bank wants the partner to confirm (3-D Secure):** kind `billing_card_action_required`.
  - It is not a penalty.
  - The words name only the ways to pay that exist today.
- **A Pay now kept for the next weekly fee** (settlement `banked`: a week that has not started, or a payment that could not move the plan): kind `billing_banked`.
- No new notification kind is introduced by PT-2.

## 11. Not in this contract yet

- **What the real provider (PT-4) does and does not do**, from its own guide v2.7 only:
  - Pay now by card, on its hosted page with 3-D Secure; Swift completes the payment only when the bank's check passed (verified or attempted), and only the provider's answer to that completion books the week, once.
  - No saved cards: the guide documents no weekly charge without the partner present and returns no last 4 or expiry. `addCard` is `false` with it, whatever the switch says.
  - Refund (sec. 3 "Refund a previously authorized transaction", 5.2, 7.5: POST /api/refund naming the ORIGINAL TransactionIdentifier, with TotalAmount and Refund true) and void (5.2, 7.6). Swift uses the refund twice, each a two-person admin action sent once: a HELD Pay now (section 8, REFUND) and, at closing, weekly-fee money paid ahead by card going back to its card (Subscriptions "Refund to card", `POST /api/v1/admin/subscriptions/{id}/refund-credit/card`; whole card payments only, recorded only on the provider's approved answer).
  - Not in the guide, but answered by PowerTranz in writing (4 Nov 2026): the transaction lookup, `GET <root>/api/Transactions/{TransactionIdentifier}`, only when an outcome is unknown (section 8). The guide v2.7 lists no inquiry call; PowerTranz's answer is the source for it. PowerTranz's written answer of 9 Nov 2026 adds that it is supported for all transaction types (used for "Check with the card provider", section 8).
  - Not in the guide, so not done: a refund made by hand in the merchant portal (the guide names the portal only for page names, 5.1, and order references in reports, 9.2), and a refund smaller than the payment (5.2: "partial voids are not supported. Only partial captures are supported").
- **Questions for PowerTranz** (asked through the coordinator):
  - how a saved card is charged each week without the partner present (a merchant-initiated or recurring indicator, and the 3-D Secure and CVV rules);
  - GYD (ISO 4217 `328`) acceptance and settlement;
  - our hosted `PageSet` / `PageName`, and styling it as Swift; whether the hosted page collects the cardholder details 3-D Secure 2 needs (guide sec. 9.3) or Swift must send them;
  - whether `MerchantResponseUrl` must be registered, and the exact shape of the frame's post to it;
  - whether the payment completion's answer carries the original `TransactionIdentifier` (how to look up a completion whose answer was lost is answered: the transaction lookup, section 8);
  - the transaction lookup's exact answer: a sample for an approved 3-D Secure Sale; whether `TransactionIdentifier`, `OrderIdentifier`, `TransactionType`, `Approved`, `IsoResponseCode` and `CurrencyCode` sit at its top level beside `OrderSummary` and `VoidDateTime`; what `VoidDateTime` holds on a transaction that was not voided (absent, null, a default date) and its format when set; whether the `OrderSummary` amounts are major units like `TotalAmount`, and whether `TotalCaptureAmount` is the sale amount before settlement; whether it carries the 3-D Secure proof (`RiskManagement.ThreeDSecure`); what it answers for a transaction it does not know, and how soon after a completion the record is readable and final; its production address (Swift reads `<API root>/api/Transactions/{id}`, the root without `/spi`) and whether it needs the gateway key; any rate limit;
  - whether the original transaction's record lists the refunds and voids made on it, each with its own `TransactionIdentifier` (a lost refund answer is checked by `TotalCreditAmount` today, section 8, and recorded under Swift's own reference until then);
  - whether the hosted page works inside an iframe in iPhone Safari (third-party cookies) and Android in-app browsers;
  - the production API root (the guide says it is provided after staging is validated);
  - enabling `PanToken` on a Pay now;
  - can a person refund a payment in the Merchant Portal, and if so which refund reference does the portal show (Swift records refunds only from the API answer until this is answered);
  - can a refund be smaller than the original payment (a partial refund), and with which answer when it cannot (sec. 5.2 documents partial captures only);
  - does the Merchant Portal find a payment by its TransactionIdentifier, or only by the OrderIdentifier (`SWIFT-<card payment id>`, sec. 9.2);
  - is the refund's own TransactionIdentifier (sec. 7.5 answer) shown in the portal and on the settlement report, so finance can match a refund Swift recorded.
- The UI (a separate lane builds it against this contract and the simulator).
- The credential setup tool (PT-5, for MMG and the card provider together): `deploy/owner/swift-payments-setup.command`. Its server self-check prints OK / FAIL lines naming only known settings (`SELF_CHECK_SETTING_NAMES`); the sandbox page it sets up (Redis prefix `ptz:selfcheck:`) is abandoned at once and its record expires after one hour (`SELF_CHECK_RECORD_TTL_MS`).

Changes to this contract are made here first, in the same PR as the code that changes.
