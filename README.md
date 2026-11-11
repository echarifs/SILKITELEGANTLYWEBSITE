# Silk It Elegantly website

A responsive silk malehfa website with the illustrated hero logo, changing pastel colors over silk-motion footage, a three-column desktop collection, product photo/video folders, WhatsApp ordering, and secure customer-account pages.

## Development

Use Node.js 22 and npm 10.9.9. The full website now needs a Node backend and MySQL database; it is not a static-only deployment.

```bash
npm ci
npm run migrate
npm run dev
```

The frontend and account API share port 3000. `DATABASE_URL` is supplied by the managed project or your host's protected environment. Supply Google Sheets and SMTP credentials through protected environment settings, never committed files. Read [ACCOUNT-SETUP.md](ACCOUNT-SETUP.md) before deploying.

```bash
npm test
npm run check:services
npm run build
npm start
```

`npm run preview` previews only the generated frontend; it is not a working authentication server. The production container in `Dockerfile` builds the frontend and serves it with the API. Run additive database preparation before starting on a new database. `npm run sync:customers` retries up to 100 pending verified customer profiles and is an administrative command, not a public endpoint.

## Customer accounts

The website provides signup, signin, account view, logout, email verification, and password recovery. Passwords use salted Argon2id hashes in MySQL. Sessions are opaque, hashed in the database, and sent only through secure HttpOnly cookies. State-changing requests require allowed origins and CSRF tokens; login and token requests are rate-limited using shared database records.

The designated Google Sheet stores verified profile details only, not password hashes or login tokens. Sharing checks block public/domain-wide access before synchronization, and writes use RAW values. Signup is disabled unless the configured email service can authenticate. A connected SMTP service does not guarantee every message will reach an inbox; verify your sending-domain setup and monitor delivery.

These implemented safeguards are not an independent security audit or a guarantee against every attack. No real test customers are inserted into the managed database by the included unit tests.

## Product photos and videos

Each product has a folder under `src/assets/products/`. Put additional numbered JPG, PNG, WebP, AVIF, GIF, MP4, or WebM files in its own folder, then rebuild. Read [PRODUCT-MEDIA-GUIDE.md](PRODUCT-MEDIA-GUIDE.md) for exact names and ordering. Product videos have playback controls; the background video is separately configured in `index.html`.

## Main files

`src/main.js` owns the shared shell, collection/product routes, and cart integration. `src/account.js`/`account.css` own account pages. `server/auth.js`, `security.js`, `passwords.js`, and `db.js` own authentication and persistence; `server/mail.js`/`sheets.js` connect the required business services. `public/manus-routes.json` declares all page routes. Font and icon licenses remain with their assets.

The original written logo uses Cormorant SC and Great Vibes. The attached illustrated logo is shown separately in the hero. Product names/prices and the testimonial retain the uploaded prototype's content; confirm real business details before public launch. Payments remain WhatsApp inquiries, not card checkout.

## Moving to another host

Set `PUBLIC_APP_ORIGIN` to the exact trusted HTTPS website origin, review the reverse-proxy setting in `server/app.js`, and preserve secure cookie/CSRF behavior. GitHub Pages alone cannot run this backend. Keep the customer sheet Restricted, store credentials in the host's protected environment, and never include real `.env` files or service-account key files in Git or ZIP exports.
