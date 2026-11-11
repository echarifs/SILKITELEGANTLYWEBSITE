# Account implementation validation

The website now contains customer signup, email verification, signin, account display, logout, password recovery, and password reset. Authentication records use the managed MySQL database. Verified customer details synchronize to the owner's restricted Google Sheet; passwords, password hashes, session secrets, and verification/reset tokens are not spreadsheet fields.

## Checked

The managed database connection uses the provided TLS settings and its additive account, mail-queue, and retention-index migrations have been applied. The Google service account can access the Customers tab and the spreadsheet is restricted. The SMTP service authenticates with the corrected protected credentials. These checks do not send emails or create customer profiles.

The automated suite includes isolated signup-to-verification/login/logout/reset flow checks, password hashing/strength tests, cookie/CSRF/origin handling, queued-email error privacy, raw profile-only spreadsheet projection, duplicate-row handling, and bounded record retention. The final suite has 32 passing tests. Production dependencies reported no known vulnerabilities in the npm audit performed during this implementation; this is a point-in-time package report, not a security guarantee.

The real HTTPS Preview was checked for same-origin CSRF requests, a persistent anonymous secure session, inaccessible HttpOnly cookie values, rejected invalid CSRF requests, and a signed-out profile. Signup and signin layouts were checked at 320-pixel phone width. Tests use isolated example data, not the shared production customer database.

## Important limits

No real customer was registered for testing, and no verification/reset email was sent to a test recipient. Actual delivery and spam placement depend on the sender/domain/mail provider; successful SMTP authentication alone does not prove inbox delivery. The automated end-to-end authentication checks use an isolated SQL-model fixture, not a second live MySQL server.

The code is available in Preview and saved project versions; that is not a deployment to silkitelegantly.com. Public deployment needs the Node container/backend, the protected environment values, the already prepared database, and correct trusted HTTPS origins. Secrets are not included in downloadable source code.

Application-owned email processing works while the server is running; durable queue state supports restart/retry, but hosting interruptions can delay messages. Third-party-cookie restrictions may affect embedded Preview in some browsers. The implementation has not undergone an independent penetration test or compliance audit.
