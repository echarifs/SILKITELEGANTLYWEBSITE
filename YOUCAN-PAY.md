# YouCan Pay integration notes

Implementation remains sandbox-only until the merchant is approved and live credentials are supplied securely.

## Verified API flow

- The official Payment Flow uses a server-created token, a browser-rendered `yp.js` payment element, customer confirmation, and a server-verified payment result. The server token request carries amount in minor currency units, currency, and the store order ID. The current sandbox endpoint returned a JSON object containing only `token` when called with the configured credentials, despite the general tokenization reference documenting a `transaction_id` field as well.
- Sandbox tokenization uses `POST https://youcanpay.com/sandbox/api/tokenize` with the sandbox private key. The public browser key must also be a sandbox key; `yp.js` detects sandbox mode from the token.
- `yp.js` is loaded from `https://youcanpay.com/yp.js`. Its `credit-card` gateway supports 3-D Secure. `confirm()` handles the 3DS challenge and returns a success/failure result; the browser result alone must not fulfill an order.
- YouCan Pay webhook notifications include `event_name`, a sandbox flag, and a transaction payload. Verify `X-YOUCANPAY-SIGNATURE` as HMAC-SHA256 over the exact raw request body using the private key, comparing in constant time. Only then trust the parsed payload.
- Before fulfillment, the official flow says to verify transaction details and match the amount and order ID. The signed webhook must be checked against the locally stored order, currency, amount, sandbox flag, and provider transaction reference. When sandbox tokenization omits `transaction_id`, the application may bind it only from the first valid signed event that already matches the order, amount and currency; later events must match that bound value.
- The API v2 authentication guide says sandbox keys are rejected by its API v2 endpoints. The sandbox documentation explicitly documents sandbox tokenization; don't assume sandbox keys work for v2 transaction/refund operations without provider confirmation.
- The sandbox test-card list documents `4242 4242 4242 4242` as a successful Visa payment without 3DS, and `4000 0000 0000 3220` as a successful Visa payment after approving the simulated 3DS challenge. It also lists decline cards. Use any future expiry and any CVV. This does not establish which card brands are enabled on the merchant account; Visa/Mastercard availability depends on approved merchant configuration.
- Webhooks require a publicly reachable HTTPS endpoint. A local or private Preview address cannot receive provider callbacks unless YouCan Pay can reach that exact URL and accept it in webhook settings.

## Official sources

- [YouCan Pay Introduction](https://docs.youcan.shop/youcan-pay/introduction)
- [Authentication](https://docs.youcan.shop/youcan-pay/authentication)
- [Payment Flow](https://docs.youcan.shop/youcan-pay/payment-flow)
- [Tokenize Payment](https://docs.youcan.shop/youcan-pay/payment/tokenize)
- [yp.js Getting Started](https://docs.youcan.shop/youcan-pay/yp-js/getting-started)
- [yp.js Sandbox & Testing](https://docs.youcan.shop/youcan-pay/yp-js/sandbox)
- [Webhooks](https://docs.youcan.shop/youcan-pay/webhooks)
- [Transactions API](https://docs.youcan.shop/youcan-pay/transactions/list)
- [Transaction Object](https://docs.youcan.shop/youcan-pay/transactions/object)
- [Create a Refund](https://docs.youcan.shop/youcan-pay/refunds/create)


## Important sandbox boundary

- The official webhook-create API reference states that webhooks created through API v2 are always live. This integration will not call that endpoint. A sandbox callback must be registered through a YouCan Pay sandbox/dashboard facility if one is available; the owner must confirm the exact sandbox URL and provider behavior before callback testing.
- The documented refund-create and transaction-read endpoints are API v2, while the authentication guide says sandbox keys are rejected by API v2. Do not call those endpoints from this sandbox-only integration. The webhook handler can process and email a correctly signed sandbox refund event if YouCan Pay emits one; refund-API execution remains disabled until the provider documents a sandbox refund route or live activation is later explicitly approved.
- The current project has no order-management table and no admin order UI. This implementation adds persistent order records and stores provider transaction references; it does not invent or expose an unauthenticated admin dashboard.

Additional official references: [Webhook Object](https://docs.youcan.shop/youcan-pay/webhooks/object), [Create a Webhook](https://docs.youcan.shop/youcan-pay/webhooks/create), and [Refund Object](https://docs.youcan.shop/youcan-pay/refunds/object).


The official webhook example confirms the signature is a hex HMAC-SHA256 digest and the event carries a top-level `sandbox` boolean plus `payload.transaction` fields for `id`, `amount`, `currency`, and `order_id`. The same example includes card metadata (brand, fingerprint, last digits, country, and 3-D Secure flag). The receiver intentionally parses only event identity and transaction fields needed for order reconciliation; it neither logs nor stores the raw body or `payment_method.card` metadata.


## Project setup and remaining prerequisites

- Webdev protected settings use `YOUCANPAY_SANDBOX_PRIVATE_KEY`, `YOUCANPAY_SANDBOX_PUBLIC_KEY`, and `SMTP_URL`. Transactional mail uses the SMTP-authenticated mailbox as its sender; a separate `SMTP_FROM` value is ignored. The sandbox private key is used only by the server; the browser receives only the sandbox public key and short-lived payment token. No live YouCan Pay key or endpoint is implemented.
- The current Preview origin successfully loaded the hosted card form in the 2026-11-03 attempt. If the Preview origin changes or YouCan Pay rejects a host, add the current origin to the sandbox allowed-host list.
- This project implements a signed webhook receiver at `POST /api/webhooks/youcan-pay`, but no signed webhook was received for the 2026-11-03 sandbox order. Register the full callback URL using the active public Preview origin through a supported sandbox dashboard workflow; the official API-v2 create-webhook endpoint creates live webhooks only and must not be used for this sandbox-only integration.
- A direct sandbox tokenization request succeeded with a token-only response. An earlier integrated 85 EUR synthetic checkout failed because the application required a transaction ID during token creation; no card details were submitted in that earlier attempt. One failed test order remains in the shared managed database.
- SMTP now authenticates in Preview after a protected credential replacement. Account signup is enabled; actual customer inbox delivery has not been verified. The connection value is not included in this document.
- The supplied prototype had no order table or admin order screen. This work adds persistent order/payment records only; it does not create an admin dashboard or calculate shipping/taxes. Confirm these business rules before any future live activation.


## Integrated sandbox checkout attempt — 2026-11-03

- After the Preview restart, the homepage and `/manus-routes.json` responded successfully. The cart flow reached the provider-hosted YouCan Pay `yp.js` card fields.
- A synthetic checkout used the documented test Visa `4242 4242 4242 4242`; expiry `12/30` and CVV `123` were entered directly into the provider-hosted form. No 3-D Secure challenge appeared, matching the provider's documented behavior for this test card. No live card or live payment endpoint was used.
- The storefront displayed a submitted-payment message and said it was waiting for YouCan Pay's signed confirmation. A read-only query of the latest order showed sandbox mode, `pending_payment`, EUR 85.00, and no provider transaction reference. No signed webhook was observed. Treat the payment as unconfirmed; order-status transition, confirmation email queueing, and customer inbox delivery remain unverified.
- Card fields were supplied to the provider-hosted component; the application stores neither card number nor CVV. The test order is stored as ordinary sandbox order metadata only.
- To complete verification, confirm the active Preview origin is on YouCan Pay's sandbox allowed-host list, then register the full callback URL ending in `/api/webhooks/youcan-pay` through a supported dashboard workflow. Do not use API v2 webhook creation, which the provider documents as live-only.
