# YouCan Pay integration and account-readiness plan

## Scope and constraints

Implement a sandbox-only card checkout for the existing Silk It Elegantly storefront using YouCan Pay's official `yp.js` flow. Keep the current visual language and cart UX. The existing project has no order-management table; its cart currently builds a WhatsApp message. Add minimal persistent order/payment records so checkout can use server-controlled totals, retain YouCan Pay transaction references, and accept verified provider events. Do not publish the site or enable live card payments.

The current storefront displays prices in EUR. Keep EUR as the checkout currency and convert trusted product prices to integer minor units for YouCan Pay. The provider documents that Moroccan-card currency conversion may occur in YouCan Pay; actual Moroccan/international Visa and Mastercard availability depends on merchant-account approval and enabled gateway settings.

## Implementation

- Extract the product/variant price map into a dependency-free shared module imported by the frontend and Node backend. The browser submits only product IDs, variant names, quantities and customer contact details; the server recalculates every line and total.
- Add a checkout panel that collects the email/name needed for order records and receipts. The delegated form submit handler must operate on the actual submitted form element, not its `document` event listener. Load YouCan Pay `yp.js` on demand, render only the `credit-card` gateway, and rely on its supported 3-D Secure confirmation flow. The browser never receives or posts card numbers/CVV to Silk It Elegantly.
- Create a sandbox order row before requesting a token. Use only `https://youcanpay.com/sandbox/api/tokenize` with sandbox-only credentials. Return the short-lived payment token and sandbox public key to the browser; never store or expose the private key. The official tokenization response documents a transaction ID, but the configured sandbox endpoint returned only a token during the live test. Permit a missing ID at token creation and leave the order's provider reference empty until an authenticated signed sandbox event supplies it. The application has no live endpoint/key switch in this task and rejects non-sandbox keys.
- Add additive MySQL migrations for orders, webhook idempotency records and payment/refund email jobs. Persist item snapshots, EUR amount, order/payment status and YouCan Pay transaction ID. Do not store card data, and do not sync orders/payments to Google Sheets.
- Add the YouCan Pay webhook route before JSON body parsing. Verify `X-YOUCANPAY-SIGNATURE` as HMAC-SHA256 over the exact raw body using the sandbox private key and a constant-time comparison. Require sandbox events and match the stored order ID, amount and currency before changing an order. If tokenization supplied a transaction reference, require an exact match; if the tokenization response omitted it, bind the transaction ID from the first valid signed event only after the order/amount/currency match, then require exact reference matches for subsequent events. Deduplicate provider event IDs and queue receipts/refund notifications within the same database transaction.
- Extend the existing SMTP worker with retryable payment-confirmation and refund emails. A browser-side success response is only pending confirmation; a signed webhook controls the paid/refunded status.
- Extend CSP only for the official YouCan Pay script/API/frame origins used by `yp.js`, keeping existing protections and preview embedding behavior.
- In development Preview only, allow the exact `http://127.0.0.1:<PORT>` and `http://localhost:<PORT>` origins because the Preview proxy rewrites browser `Origin` to the internal loopback listener. Keep production restricted to the configured HTTPS allowlist; do not broadly accept arbitrary or missing origins.
- Keep account registration disabled unless the existing SMTP transport passes authentication verification. After the SMTP URL was replaced through protected secret input and the Development Preview restarted, SMTP connected and `/api/auth/status` reported `emailConfigured:true` and `signupAvailable:true`. For signup inside the cross-site embedded Preview, require the exact configured Origin and JSON content type but do not depend on an anonymous cookie-based CSRF session. When the Preview proxy rewrites that request Origin to loopback, create verification and recovery links from a separately configured, allowlisted public HTTPS origin. Retain session-bound CSRF checks for other state-changing operations. For Namecheap Private Email, derive the visible message sender from the URL-decoded authenticated SMTP mailbox in `SMTP_URL`, not a separate `SMTP_FROM` value, for both account and payment notifications. Do not bypass email verification; diagnostics use synthetic/malformed data and roll back test transactions so they create no durable account or mail job.
- Persist only an allowlisted coarse SMTP failure category on retryable email jobs (authentication, connection, permanent rejection, temporary rejection, or generic failure). Never store raw SMTP responses, credentials, recipient addresses, or verification tokens in diagnostics.
- Use `libphonenumber-js` metadata in a shared phone utility. Render accessible country/calling-code selectors beside optional phone inputs in account signup and checkout, normalize entered numbers to E.164, preserve blank numbers as optional, and revalidate E.164 input server-side.

## Project structure

- `shared/phone.js`: shared country metadata and E.164 parsing/normalization.
- `src/phone-field.js`: accessible reusable country selector and client-side phone extraction.
- `src/account.js`, `src/cart-modal.html`, `src/checkout.js`: account and checkout phone UI and normalized submission.
- `src/account.css`, `src/style.css`: responsive selector styling in the existing visual language.
- `src/product-catalog.js`: shared trusted product/variant prices.
- `server/security.js`: server-side phone validation using the shared normalizer.
- `src/main.js`, `src/cart-modal.html`, `src/style.css`: cart checkout UI and `yp.js` client flow.
- `server/youcan-pay.js`: sandbox token creation and webhook signature/event validation.
- `server/payments.js`: order creation/status handling, webhook application and order migration.
- `server/mail.js`, `server/payment-mail-queue.js`, `server/workers.js`: queued payment/refund email delivery.
- `server/db.js` and `server/migrate.js`: additive order/payment schema migrations.
- `server/app.js`, `server/index.js`: routes, CSP/body-parser ordering, startup wiring.
- `public/manus-routes.json`: retain route declarations if checkout stays in the existing modal; update only if new pages are added.
- `YOUCAN-PAY.md`: official provider flow, sandbox constraints and source URLs.

## Verification and delivery

Add tests for server-side catalog pricing, amount conversion, sandbox-only key enforcement, raw-body signature validation, event deduplication, amount/order matching, status transitions and email-job creation, including token-only sandbox responses with signed-event reference binding. Add phone-number tests for country calling codes, E.164 normalization and optional/invalid values. Run the existing test suite and frontend build. Start the integrated application in the conversation Preview only after managed MySQL provisioning completes, apply migrations to that project database, and confirm its health route plus existing route manifest. Do not publish or switch to live mode.

## Provider-specific sandbox limit

The official docs say API-v2-created webhooks are always live and that sandbox keys are rejected by API v2. Do not register a webhook or call transaction/refund API-v2 endpoints from this integration. Implement and unit-test the signed webhook receiver, but require the owner to register the HTTPS endpoint through a documented sandbox-capable dashboard path before real sandbox callback validation. Refund emails are emitted only for verified refund webhook events; refund execution remains disabled in this sandbox-only scope.
