# Connecting SilkItElegantly customer accounts

Customer accounts use a protected database for password hashes, sessions, and verification/recovery tokens. Your Google Sheet receives verified customer profiles only: customer ID, name, email, optional phone, marketing consent, signup time, and verification status. Credentials are never copied to the sheet.

The sheet's public-link editor permission has been removed with your approval. Keep General access set to **Restricted**. The app will refuse to sync if the sheet becomes public or domain-wide shared.

## Google Sheets service account

This task's Google Workspace connection lets Manus prepare your spreadsheet, but it does not give a deployed website permanent access. The website needs its own server-only connection.

In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and enable **Google Sheets API** and **Google Drive API**. Create a dedicated service account for this website under IAM & Admin → Service Accounts. It does not need project-wide administrator roles or domain-wide delegation. Open the service account, choose Keys → Add key → Create new key → JSON, and download the key.

Supply the **entire downloaded JSON** in the protected field named `GOOGLE_SERVICE_ACCOUNT_JSON`. Never paste it into chat, put it in the public website folder, or commit it to GitHub. Google documents this procedure in its [server-to-server authentication guide](https://developers.google.com/identity/protocols/oauth2/service-account).

The JSON contains a non-secret `client_email` address. Share [your customer spreadsheet](https://docs.google.com/spreadsheets/d/16nJbuyTdPlDDSXnSRPGDFyyxjLS0Prif3FjupQfQQSc/edit) with that service-account address as **Editor**, while keeping General access Restricted. Share only this spreadsheet with the service account.

The website uses a dedicated **Customers** tab and does not overwrite unrelated tabs. Do not manually edit customer IDs or sort/reorder the underlying Customers rows while syncing; use a filter view for exploring data. The database remains the source of truth. A Google API outage leaves the profile sync pending/failed rather than disabling authentication or claiming data was saved.

## Verification and password-reset email

Use an SMTP service authorized to send for your brand. Your provider will supply its SMTP hostname, port, username, and SMTP password/API credential. This is **not** a customer's password and should not be your regular personal email password.

Enter its authenticated connection URL in protected `SMTP_URL`. An example of the format, with nonworking stand-ins, is `smtps://USERNAME:PASSWORD@smtp.provider.example:465`. For a provider using port 587, use `smtp://USERNAME:PASSWORD@smtp.provider.example:587`; the app requires STARTTLS. Percent-encode special characters in username/password before assembling the URL. Do not disable certificate verification.

The app uses the URL-decoded SMTP username as the visible `From` address; no separate `SMTP_FROM` setting is used. For Namecheap Private Email, the SMTP username must be the full mailbox address. If a branded alias is needed later, first configure it as an alias on that mailbox in the provider dashboard; this app currently sends from the authenticated mailbox itself. See Namecheap's [SMTP configuration](https://www.namecheap.com/support/knowledgebase/article.aspx/1179/2175/general-private-email-configuration-for-mail-clients-and-mobile-devices/) and [alias guide](https://www.namecheap.com/support/knowledgebase/article.aspx/10791/2215/how-to-create-an-alias-for-namecheap-private-email/). Sending domains may also require SPF/DKIM setup in the provider dashboard; a connection URL alone does not establish deliverability.

Verification and reset links expire and can be used only once. Verification requires the account password again, so a forwarded or unsolicited link does not silently create a signed-in account. Links are consumed by a deliberate form submission, not merely by opening an email.

Until email delivery is configured, new signup is intentionally unavailable. A working form must not pretend that a verification email was sent. Existing verified accounts may sign in if their database is available, even during an email outage.

## Hosting and deployment

This version needs a Node server and MySQL database. It is no longer a static-only HTML/Vite deployment: GitHub Pages alone cannot run its authentication API. The managed project's database is provided through `DATABASE_URL`. Development and deployed versions share that database, so do not insert test customers into it.

Set `PUBLIC_APP_ORIGIN` to the exact trusted HTTPS website origin when deploying to another host, and review the `trust proxy` setting for that host's ingress. Email links must use a validated website origin, never an arbitrary return URL supplied by a visitor. The app uses secure, HttpOnly, host-only cookies with CSRF protection; third-party-cookie restrictions can still prevent embedded Preview sessions in some browsers. Standalone HTTPS testing is appropriate when that browser limitation occurs.

Run `npm run migrate` for additive database preparation, then `npm run dev` for Preview/local development or `npm run build && npm start` for production. Run `npm run check:services` to confirm email authentication and private-sheet access without sending mail or creating customer records. Use `npm run sync:customers` as an administrative retry for pending verified profiles. Keep secrets in the host's protected environment variables, not a committed `.env` file. The source ZIP intentionally excludes real credentials. After adding product-media files, rebuild as before.

## Privacy and maintenance

Ask only for the information needed for customer accounts. Marketing consent is separate and unchecked by default. Give only trusted people access to the customer sheet and database. Use your mail provider's approved sender, keep dependencies updated, monitor failed mail and synchronization, and rotate a service-account key if it is exposed. The app has implemented security controls; it is not a guarantee against every attack or an independent security audit.

### Security references

[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), and [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) inform password hashing, validation, rate limits, session expiry, and recovery controls. [Google Sheets values.update](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update) documents RAW writes; [Google Drive permissions.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list) documents sharing checks.

## Email queue and record retention

Registration and recovery return the same generic response regardless of whether an address already exists or an email send later fails. A durable database queue holds only the customer ID, mail type, trusted origin, and retry state—not raw verification tokens or message bodies. The backend processes bounded batches every 30 seconds while it is running, with at most three delivery attempts and five-minute retry delays. Email may be delayed; customers can request a fresh link. Queue processing resumes after restart; it is not a promise of uninterrupted execution when hosting is asleep or unavailable. `npm run retry:mail` is a finite administrative retry command.

Internal expired/revoked sessions and consumed/expired tokens are retained for at least a day, stale rate buckets for two days, and completed/failed mail jobs for seven days before bounded cleanup. Customer profiles and spreadsheet rows are not removed by this process. `npm run cleanup:auth` runs a bounded cleanup manually.
