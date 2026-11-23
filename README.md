# CvSU CSSO Event QR Attendance System

A hardened Google Sheets + Google Apps Script + GitHub Pages QR attendance system for CvSU CSSO events.

## Architecture
- **Google Sheets (`Roster`, `Config`, `Attendance Log`, `Verified Attendance`)** — Administrative registration, event configuration, authoritative append-only scan ledger, and per-student qualification summary.
- **Google Apps Script (`Code.js`, `QrEncoder.js`, `Index.html`)** — `doPost(e)` JSON API, stateless HMAC-SHA256 usher sessions, `v2|EVENT_ID|STUDENT_ID|HMAC` + legacy `v1` verification, locally bundled pure-JS QR PNG generation (`qrcode-generator@2.0.4`, MIT), and `GmailApp` email dispatch.
- **Standalone HTTPS Scanner (`docs/index.html`)** — Hosted on GitHub Pages with self-hosted `docs/vendor/html5-qrcode.min.js` (`2.3.8`) so Chrome and Safari grant real camera permissions without Google Apps Script iframe restrictions.

## Administrative Registration Procedure (Google Sheets)
Google Sheets (`Roster` tab) is the administrative registration interface:
1. Open the `Roster` tab.
2. Enter one participant per row in Columns A–D:
   - **Col A (`Student ID`)**: Plain text (`@` format, preserves leading zeros). Must be unique after normalization.
   - **Col B (`Email`)**: Valid participant email address.
   - **Col C (`Full Name`)**: Participant full name.
   - **Col D (`Section`)**: Course/section (e.g., `BSCS 4-2`).
3. Run **Attendance Scanner $\to$ 🚀 Implement New Features / Apply All Upgrades** to audit for duplicate normalized IDs, invalid emails, missing names, and token drift.
4. For walk-in participants added during an active event, `recordScan()` automatically bypasses the 5-minute Roster cache on miss so they can be scanned immediately.

## QR Pass Issuance & Honest Email Semantics
- **Zero Third-Party Token URLs:** QR PNGs are generated locally inside Apps Script (`QrEncoder.js`) and attached as inline PNGs (`cid:qrpass`). Participant signing tokens are never sent in third-party URL query strings.
- **Email Dispatch (`GmailApp`):** Uses `GmailApp.sendEmail()` (requires one-time `https://mail.google.com/` OAuth consent) so dispatched passes appear in the sender's Gmail **Sent** folder.
- **`DISPATCHED` Semantics:** `Pass Status = DISPATCHED` means `GmailApp.sendEmail()` accepted the request without throwing — **it is NOT proof of recipient inbox delivery or bounce absence**. Organizers must reconcile distribution before event cutover.

## Event Lifecycle, `DEFAULT` Reservation & 7-Step Transition
- **`DEFAULT` is reserved exclusively** for the legacy `v1` compatibility event (`V1_COMPAT_EVENT_ID = DEFAULT`). Never reuse `DEFAULT` for a new event.
- **Pre-Issuance (`TARGET_EVENT_ID`):** Run `setTargetEventId('CSSO-2026-EVENT')` to persist `TARGET_EVENT_ID` without changing active `Config.EVENT_ID`. Target `v2` passes are rejected (`REJECTED_WRONG_EVENT`) until activated, while existing `v1` passes continue working during preparation.
- **Resumable 7-Step Transition (`transitionToTargetEvent()`):** Persists `EVENT_TRANSITION_PENDING = TRUE`, irreversibly sets `V1_COMPAT_RETIRED = TRUE`, updates `Config.EVENT_ID = TARGET_EVENT_ID`, self-verifies `v2` acceptance, and clears `EVENT_TRANSITION_PENDING`. Once `V1_COMPAT_RETIRED` is `TRUE`, `v1` passes remain permanently rejected even if `Config.EVENT_ID` is set back to `DEFAULT`.

## Secret Migration, Rotation & Protocol-Aware Rollback
- **Migration (no key change):** `migrateSecretsToProperties()` writes `USHER_PIN`, `SECRET_SALT`, and `V1_COMPAT_EVENT_ID` into `ScriptProperties`, read-back verifies them, and clears plaintext cells in `Config`.
- **Rotation (key change):** `rotateSecretSalt(newSalt)` moves the previous `SECRET_SALT` into `LEGACY_SECRET_SALT` so existing same-event `v1`/`v2` passes remain valid until `retireLegacySecretSalt()` is run. A second rotation is refused while `LEGACY_SECRET_SALT` is populated.
- **Rollback Rules:** Older deployment `@5` predates `v2`, `LEGACY_SECRET_SALT`, and `V1_COMPAT_RETIRED`. Once `v2` passes or `V1_COMPAT_RETIRED = TRUE` are active, rolling back to `@5` is **prohibited** — recover via **forward-fix** or a verified minimum rollback-compatible deployment version.
- **Anonymous Endpoint Security Note:** Because `ANYONE_ANONYMOUS` Apps Script endpoints cannot inspect caller IP addresses, per-client rate limiting is impossible at the GAS layer and bounded server delays do not stop distributed brute-force attacks. Use a strong 6–8 digit `USHER_PIN`, rotate immediately if abuse is suspected, and consider an external gateway (e.g., Cloudflare Worker) as a future enhancement.

## Local Verification Commands
```powershell
node -c Code.js
node -c QrEncoder.js
$fail=0; Get-ChildItem tests/*.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { $fail=1 } }; exit $fail
node tests/browser/scanner.spec.js
clasp status
```
